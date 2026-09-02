"""
Thin client for the Lightspeed Retail (X-Series) REST API.

Holds the personal token server-side only - it must never reach the
till_amsons.html frontend. Every route in app.py that needs Lightspeed
data goes through the helpers here instead of calling `requests` directly,
so there is exactly one place that knows the token and base URL.

Docs: https://x-series-api.lightspeedhq.com/docs/authorization
"""

import os
import time

import requests

API_VERSION = "2.0"

# Every plain requests.get/post opened its own TCP+TLS connection - on a
# checkout that fires 5-6 sequential Lightspeed calls (registers, outlet,
# one per cart line, payment types, the sale itself) those handshakes alone
# were the whole multi-second delay. A shared Session reuses the connection.
_session = requests.Session()

# registers/outlets/payment types barely change during a shift, and a
# product's price/tax rarely changes in the few seconds between it being
# scanned and the sale being closed - caching both turns a checkout that
# used to make ~6 Lightspeed calls into just the one that actually matters
# (creating the sale).
_cache = {}
_LIST_CACHE_TTL = 600     # registers / outlets / payment types: 10 min
_PRODUCT_CACHE_TTL = 120  # products: 2 min - long enough to cover scan->checkout


def _cache_get(key):
    hit = _cache.get(key)
    if hit and hit[1] > time.time():
        return hit[0]
    return None


def _cache_set(key, value, ttl):
    _cache[key] = (value, time.time() + ttl)


class LightspeedError(Exception):
    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _domain_prefix():
    domain_prefix = os.environ.get("LIGHTSPEED_DOMAIN_PREFIX", "")
    if not domain_prefix:
        raise LightspeedError(500, "LIGHTSPEED_DOMAIN_PREFIX is not set in .env")
    return domain_prefix


def _base_url():
    return f"https://{_domain_prefix()}.retail.lightspeed.app/api/{API_VERSION}"


def _legacy_base_url():
    """register_sales is a v0.9-era endpoint that was never moved under
    /api/2.0/ - it lives directly at /api/register_sales. Everything else
    (products, registers, outlets, taxes, payment_types) is v2.0.
    https://x-series-api.lightspeedhq.com/docs/sync_sale_into_vend
    """
    return f"https://{_domain_prefix()}.retail.lightspeed.app/api"


def _headers():
    token = os.environ.get("LIGHTSPEED_TOKEN", "")
    if not token:
        raise LightspeedError(500, "LIGHTSPEED_TOKEN is not set in .env")
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def get(path, params=None):
    resp = _session.get(f"{_base_url()}{path}", headers=_headers(), params=params, timeout=10)
    if resp.status_code >= 400:
        raise LightspeedError(resp.status_code, resp.text)
    return resp.json()


def post(path, json_body):
    resp = _session.post(f"{_base_url()}{path}", headers=_headers(), json=json_body, timeout=10)
    if resp.status_code >= 400:
        raise LightspeedError(resp.status_code, resp.text)
    return resp.json()


def get_legacy(path, params=None):
    resp = _session.get(f"{_legacy_base_url()}{path}", headers=_headers(), params=params, timeout=10)
    if resp.status_code >= 400:
        raise LightspeedError(resp.status_code, resp.text)
    return resp.json()


def post_legacy(path, json_body):
    resp = _session.post(f"{_legacy_base_url()}{path}", headers=_headers(), json=json_body, timeout=10)
    if resp.status_code >= 400:
        raise LightspeedError(resp.status_code, resp.text)
    return resp.json()


def find_product_by_sku(sku):
    """SKU is where barcode values normally live for scanned retail products.
    An exact ?sku= match returns `data` as a single object; no match returns
    an empty list instead. https://x-series-api.lightspeedhq.com/docs/quick_start

    Cached briefly: the barcode scan that put this item in the cart already
    called this a few seconds earlier, so checkout can usually reuse that
    result instead of hitting Lightspeed again for every line item.
    """
    cache_key = f"product:{sku}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    data = get("/products", params={"sku": sku})
    result = data.get("data")
    if isinstance(result, list):
        result = result[0] if result else None

    if result:
        _cache_set(cache_key, result, _PRODUCT_CACHE_TTL)
    return result


def list_registers():
    cached = _cache_get("registers")
    if cached is not None:
        return cached
    registers = get("/registers").get("data", [])
    _cache_set("registers", registers, _LIST_CACHE_TTL)
    return registers


def get_register(register_id):
    for register in list_registers():
        if register.get("id") == register_id:
            return register
    return None


def get_outlet(outlet_id):
    cached = _cache_get("outlets")
    if cached is None:
        cached = get("/outlets").get("data", [])
        _cache_set("outlets", cached, _LIST_CACHE_TTL)
    for outlet in cached:
        if outlet.get("id") == outlet_id:
            return outlet
    return None


def list_payment_types():
    cached = _cache_get("payment_types")
    if cached is not None:
        return cached
    payment_types = get("/payment_types").get("data", [])
    _cache_set("payment_types", payment_types, _LIST_CACHE_TTL)
    return payment_types


def find_payment_type_by_name(name):
    for payment_type in list_payment_types():
        if payment_type.get("name", "").lower() == name.lower():
            return payment_type
    return None


def find_payment_type_containing(*keywords):
    """Looser lookup for payment types whose exact configured name we don't
    control (e.g. a retailer's gift-card type might be "Gift Card", "Gift
    Voucher", "Voucher"...). Matches the first payment type whose name
    contains any of the given keywords, case-insensitive."""
    for payment_type in list_payment_types():
        name = payment_type.get("name", "").lower()
        if any(keyword.lower() in name for keyword in keywords):
            return payment_type
    return None


def list_product_types():
    """These are the CATEGORIES shown on the dashboard - whatever an admin
    sets up under Products > Types in the Lightspeed back office shows up
    here automatically, nothing to redeploy."""
    cached = _cache_get("product_types")
    if cached is not None:
        return cached
    product_types = get("/product_types").get("data", [])
    _cache_set("product_types", product_types, _LIST_CACHE_TTL)
    return product_types


def list_tags():
    cached = _cache_get("tags")
    if cached is not None:
        return cached
    tags = get("/tags").get("data", [])
    _cache_set("tags", tags, _LIST_CACHE_TTL)
    return tags


def find_tag_by_name(name):
    for tag in list_tags():
        if tag.get("name", "").lower() == name.lower():
            return tag
    return None


def search_products(params, limit=24):
    query = dict(params)
    query["type"] = "products"
    query["page_size"] = limit
    return get("/search", params=query).get("data", [])


def quick_pick_products(tag_name="Quick Pick", limit=100):
    """The PRODUCTS shelf - an admin tags however many favourite products
    they want with this exact tag in Lightspeed and every one of them
    shows up here (the dashboard grid scrolls if there's a lot). No tag
    yet -> empty list, so the dashboard just shows nothing to pick instead
    of erroring. `limit` is just a sanity ceiling, not a UX cap."""
    tag = find_tag_by_name(tag_name)
    if not tag:
        return []
    return search_products({"tag_id": tag["id"]}, limit=limit)


def products_by_category(product_type_id, limit=30):
    return search_products({"product_type_id": product_type_id}, limit=limit)


def _resolve_register_and_tax(register_id):
    """A sale line item needs a tax_id. Products in this account don't carry
    their own (checked via /products - only outlets do), so every line uses
    the sale's outlet default_tax_id, same as the real Sell screen would.
    """
    register = get_register(register_id)
    if not register:
        raise LightspeedError(404, f"No register found with id {register_id}")
    outlet = get_outlet(register.get("outlet_id"))
    if not outlet:
        raise LightspeedError(404, f"No outlet found for register {register_id}")
    return register, outlet.get("default_tax_id")


def _build_line_items(register_id, items, tax_id):
    """items: [{"sku": "...", "quantity": 1, "discount": {...}}, ...] from the
    frontend cart. Prices always come from a fresh Lightspeed product lookup
    here - never trust a price the browser sends, the browser can be
    tampered with. We only trust the *discount instruction* (type + value),
    not any price/total the browser computed from it.

    quantity may be negative (goods returns: negate the quantity, everything
    below - tax, discount, the sale total - falls out correctly because it's
    all a straight multiply-through).

    A "discount" dict is {"type": "percent"|"amount", "value": N}, applied to
    this line's tax-inclusive total. Per Lightspeed's docs
    (https://x-series-api.lightspeedhq.com/docs/sales_discounts), a line
    discount is a currency amount that reduces price/tax proportionally, and
    needs price_set=1 so Lightspeed doesn't recalculate it away.
    """
    line_items = []
    for item in items:
        product = find_product_by_sku(item["sku"])
        if not product:
            raise LightspeedError(404, f"Unknown product sku {item['sku']}")
        quantity = item.get("quantity", 1)
        price_inc = product.get("price_including_tax") or 0
        price_exc = product.get("price_excluding_tax") or 0
        unit_tax = round(price_inc - price_exc, 4)

        line_price = price_exc
        line_tax = round(unit_tax * quantity, 2)
        line_item = {
            "product_id": product["id"],
            "register_id": register_id,
            "quantity": quantity,
            "price": line_price,
            "tax": line_tax,
            "tax_id": tax_id,
            "status": "CONFIRMED",
        }

        discount = item.get("discount")
        if discount and discount.get("value"):
            original_total_exc = price_exc * quantity
            original_total_tax = line_tax
            original_total_inc = original_total_exc + original_total_tax

            if discount.get("type") == "percent":
                factor = max(0.0, 1 - (float(discount["value"]) / 100))
            else:
                reduction = min(float(discount["value"]), abs(original_total_inc))
                factor = 0.0 if original_total_inc == 0 else max(0.0, 1 - (reduction / abs(original_total_inc)))

            new_total_exc = round(original_total_exc * factor, 4)
            new_total_tax = round(original_total_tax * factor, 2)
            discount_amount = round(original_total_inc - (new_total_exc + new_total_tax), 2)

            line_item["price"] = round(new_total_exc / quantity, 4) if quantity else 0
            line_item["tax"] = new_total_tax
            line_item["discount"] = discount_amount
            line_item["price_set"] = 1

        line_items.append(line_item)
    return line_items


def total_including_tax(line_items):
    return round(sum(li["price"] * li["quantity"] + li["tax"] for li in line_items), 2)


def create_cash_sale(register_id, items, user_id=None):
    """Cash needs no card terminal, so the till app can close the sale
    itself - this is the one payment path that does NOT hand off to
    Lightspeed's own screen.
    """
    register, tax_id = _resolve_register_and_tax(register_id)
    line_items = _build_line_items(register_id, items, tax_id)
    cash_type = find_payment_type_by_name("Cash")
    if not cash_type:
        raise LightspeedError(500, "No 'Cash' payment type configured on this Lightspeed account")

    amount = total_including_tax(line_items)
    payload = {
        "register_id": register_id,
        "state": "closed",
        "register_sale_products": line_items,
        "register_sale_payments": [{
            "register_id": register_id,
            "retailer_payment_type_id": cash_type["id"],
            "amount": amount,
        }],
    }
    if user_id:
        payload["user_id"] = user_id

    sale = post_legacy("/register_sales", payload)
    return sale.get("register_sale", sale), amount


def create_parked_sale_for_payment(register_id, items, user_id=None):
    """Card (or any other tendered-in-person payment): create the sale with
    line items only, no payment attached, then hand it to Lightspeed's own
    Sell screen via the Redirect API so the till's already-configured
    Worldpay/Lightspeed Payments integration takes the actual card payment.
    https://x-series-api.lightspeedhq.com/docs/redirect_api
    """
    register, tax_id = _resolve_register_and_tax(register_id)
    line_items = _build_line_items(register_id, items, tax_id)

    payload = {
        "register_id": register_id,
        "state": "parked",
        "register_sale_products": line_items,
    }
    if user_id:
        payload["user_id"] = user_id

    sale = post_legacy("/register_sales", payload)
    sale_data = sale.get("register_sale", sale)
    amount = total_including_tax(line_items)
    return sale_data, amount


def create_return_sale(register_id, items, method="cash", user_id=None):
    """Goods return, till-side ("blind" return - not tied to the original
    receipt). Per Lightspeed's returns doc
    (https://x-series-api.lightspeedhq.com/docs/sales_returns), quantity goes
    negative and the payment amount is negative; price/tax stay the normal
    per-unit values `_build_line_items` already computes, so passing negative
    quantities through it is all that's needed - the totals fall out
    negative automatically.

    method="cash" refunds from the till drawer (closes the sale directly,
    like create_cash_sale). method="card" only *records* the refund against
    whatever payment type looks like a card type - it does not touch the
    physical terminal, since the Redirect API has no refund handoff. Staff
    must still process the actual refund on the terminal themselves.
    """
    register, tax_id = _resolve_register_and_tax(register_id)
    return_items = [dict(item, quantity=-abs(item.get("quantity", 1))) for item in items]
    line_items = _build_line_items(register_id, return_items, tax_id)

    if method == "card":
        payment_type = find_payment_type_containing("card")
        if not payment_type:
            raise LightspeedError(500, "No card-like payment type configured on this Lightspeed account")
    else:
        payment_type = find_payment_type_by_name("Cash")
        if not payment_type:
            raise LightspeedError(500, "No 'Cash' payment type configured on this Lightspeed account")

    amount = total_including_tax(line_items)  # already negative
    payload = {
        "register_id": register_id,
        "state": "closed",
        "register_sale_products": line_items,
        "register_sale_payments": [{
            "register_id": register_id,
            "retailer_payment_type_id": payment_type["id"],
            "amount": amount,
        }],
    }
    if user_id:
        payload["user_id"] = user_id

    sale = post_legacy("/register_sales", payload)
    return sale.get("register_sale", sale), amount


def create_voucher_sale(register_id, items, voucher_code=None, user_id=None):
    """Redeem a gift voucher/card as payment. Payment type name isn't
    standardised across Lightspeed accounts, so this matches whatever the
    retailer configured that looks like a voucher/gift-card type. The
    voucher code (if given) is stored in the sale's `note` field for the
    receipt/audit trail.
    """
    register, tax_id = _resolve_register_and_tax(register_id)
    line_items = _build_line_items(register_id, items, tax_id)
    voucher_type = find_payment_type_containing("voucher", "gift")
    if not voucher_type:
        raise LightspeedError(500, "No voucher/gift-card payment type configured on this Lightspeed account")

    amount = total_including_tax(line_items)
    payload = {
        "register_id": register_id,
        "state": "closed",
        "register_sale_products": line_items,
        "register_sale_payments": [{
            "register_id": register_id,
            "retailer_payment_type_id": voucher_type["id"],
            "amount": amount,
        }],
    }
    if voucher_code:
        payload["note"] = f"Voucher: {voucher_code}"
    if user_id:
        payload["user_id"] = user_id

    sale = post_legacy("/register_sales", payload)
    return sale.get("register_sale", sale), amount


def build_redirect_url(sale_id, action="pay", platform="web"):
    domain_prefix = os.environ.get("LIGHTSPEED_DOMAIN_PREFIX", "")
    return f"https://{domain_prefix}.retail.lightspeed.app/redirect/1.0/sales/{sale_id}?platform={platform}&action={action}"


def get_sale(sale_id):
    """GET /register_sales/:id is the same legacy resource as the POST that
    creates it, but wraps the result in a "register_sales" *array* instead
    of a singular "register_sale" object."""
    sales = get_legacy(f"/register_sales/{sale_id}").get("register_sales", [])
    return sales[0] if sales else {}


def list_recent_sales(limit=10):
    """Settings > Invoices card: the till's own last few closed sales.
    /register_sales supports a page_size query param but not a documented
    "most recent first" sort, so the newest-first ordering is done here in
    Python off each sale's own sale_date rather than trusted to the API."""
    data = get_legacy("/register_sales", params={"page_size": max(limit * 2, 20)})
    sales = data.get("register_sales", [])
    sales.sort(key=lambda s: s.get("sale_date") or "", reverse=True)
    return sales[:limit]
