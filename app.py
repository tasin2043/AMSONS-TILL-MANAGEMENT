"""
Face ID backend for the Amsons Till system.

Uses OpenCV to decode camera frames and the `face_recognition` library
(dlib's HOG detector + 128-d ResNet embeddings) to enroll and match
employee faces. Two endpoints back the till_amsons.html frontend:

  POST /api/face/register   { employeeId, images: [dataURL, ...] }
  POST /api/face/recognize  { image: dataURL }
"""

import base64
import json
import os
import threading
import time
import uuid

import cv2
import face_recognition
import numpy as np
from dotenv import load_dotenv
from flask import Flask, jsonify, request

import lightspeed

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "face_data", "encodings.json")
HOLDS_FILE = os.path.join(BASE_DIR, "till_data", "held_sales.json")
MATCH_TOLERANCE = 0.5  # lower = stricter match, 0.6 is face_recognition's own default

app = Flask(__name__)
data_lock = threading.Lock()
holds_lock = threading.Lock()


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def load_known_faces():
    if not os.path.exists(DATA_FILE):
        return {}
    with open(DATA_FILE, "r") as f:
        return json.load(f)


def save_known_faces(data):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(data, f)


def load_holds():
    if not os.path.exists(HOLDS_FILE):
        return []
    with open(HOLDS_FILE, "r") as f:
        return json.load(f)


def save_holds(holds):
    os.makedirs(os.path.dirname(HOLDS_FILE), exist_ok=True)
    with open(HOLDS_FILE, "w") as f:
        json.dump(holds, f)


def decode_image(data_url):
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    img_bytes = base64.b64decode(data_url)
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def encode_largest_face(rgb_image):
    boxes = face_recognition.face_locations(rgb_image, model="hog")
    if not boxes:
        return None
    # face_locations boxes are (top, right, bottom, left) - keep the largest face
    boxes.sort(key=lambda b: (b[2] - b[0]) * (b[1] - b[3]), reverse=True)
    encodings = face_recognition.face_encodings(rgb_image, known_face_locations=[boxes[0]])
    return encodings[0] if encodings else None


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/health/lightspeed", methods=["GET"])
def lightspeed_health():
    """Confirms LIGHTSPEED_DOMAIN_PREFIX + LIGHTSPEED_TOKEN in .env actually work."""
    try:
        retailer = lightspeed.get("/retailer")
        return jsonify({"connected": True, "retailer": retailer.get("data", {}).get("name")})
    except lightspeed.LightspeedError as err:
        return jsonify({"connected": False, "error": err.message}), err.status_code


@app.route("/api/product/<code>", methods=["GET"])
def product_lookup(code):
    """Called by the till frontend after a barcode scan (or manual code entry)."""
    try:
        product = lightspeed.find_product_by_sku(code)
    except lightspeed.LightspeedError as err:
        return jsonify({"found": False, "error": err.message}), err.status_code

    if not product:
        return jsonify({"found": False}), 404

    return jsonify({
        "found": True,
        "product": {
            "id": product.get("id"),
            "name": product.get("name"),
            "sku": product.get("sku"),
            "price": product.get("price_including_tax"),
            "tax_id": product.get("tax_id"),
        },
    })


@app.route("/api/registers", methods=["GET"])
def registers():
    """Lets the till pick its LIGHTSPEED_REGISTER_ID - every branch has
    several (e.g. "SH Till 1", "AR Till 2"), so this is here for setup,
    not called on every sale."""
    try:
        data = lightspeed.list_registers()
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code
    return jsonify({"registers": [{"id": r["id"], "name": r["name"]} for r in data]})


@app.route("/api/payment-types", methods=["GET"])
def payment_types():
    try:
        data = lightspeed.list_payment_types()
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code
    return jsonify({"payment_types": [{"id": p["id"], "name": p["name"]} for p in data]})


def _product_summary(p):
    return {
        "id": p.get("id"),
        "name": p.get("name"),
        "sku": p.get("sku"),
        "price": p.get("price_including_tax"),
    }


@app.route("/api/categories", methods=["GET"])
def categories():
    """The 4 CATEGORIES buttons - mirrors Products > Types in the
    Lightspeed back office directly, so a new category set up there shows
    up here the next time the till loads (no redeploy)."""
    try:
        data = lightspeed.list_product_types()
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code
    return jsonify({"categories": [{"id": c["id"], "name": c["name"]} for c in data]})


@app.route("/api/categories/<category_id>/products", methods=["GET"])
def category_products(category_id):
    """Product picker grid shown after tapping a CATEGORIES button."""
    try:
        data = lightspeed.products_by_category(category_id)
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code
    return jsonify({"products": [_product_summary(p) for p in data]})


@app.route("/api/products/quick-picks", methods=["GET"])
def quick_picks():
    """The 5 PRODUCTS buttons - an admin tags up to 5 products with a
    "Quick Pick" tag in Lightspeed and they show up here automatically."""
    try:
        data = lightspeed.quick_pick_products()
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code
    return jsonify({"products": [_product_summary(p) for p in data]})


def _checkout_register_id(payload):
    return payload.get("register_id") or os.environ.get("LIGHTSPEED_REGISTER_ID", "")


@app.route("/api/checkout/cash", methods=["POST", "OPTIONS"])
def checkout_cash():
    """Cart -> a closed sale in Lightspeed with a Cash payment attached.
    No card terminal involved, so this never leaves the till app."""
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    register_id = _checkout_register_id(payload)

    if not register_id:
        return jsonify({"success": False, "error": "register_id missing (set LIGHTSPEED_REGISTER_ID in .env)"}), 400
    if not items:
        return jsonify({"success": False, "error": "items is empty"}), 400

    try:
        sale, amount = lightspeed.create_cash_sale(register_id, items, user_id=payload.get("user_id"))
    except lightspeed.LightspeedError as err:
        return jsonify({"success": False, "error": err.message}), err.status_code

    tendered = payload.get("tendered_amount")
    change = round(tendered - amount, 2) if tendered is not None else None

    return jsonify({
        "success": True,
        "sale_id": sale.get("id"),
        "amount": amount,
        "change_due": change,
    })


@app.route("/api/checkout/card", methods=["POST", "OPTIONS"])
def checkout_card():
    """Cart -> a parked (unpaid) sale in Lightspeed, then a redirect URL
    that opens the SAME sale in Lightspeed's real Sell screen so its
    already-configured Worldpay / Lightspeed Payments integration takes
    the actual card payment. The till app's job stops at handing off the
    cart - it never touches card data or the terminal itself."""
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    register_id = _checkout_register_id(payload)

    if not register_id:
        return jsonify({"success": False, "error": "register_id missing (set LIGHTSPEED_REGISTER_ID in .env)"}), 400
    if not items:
        return jsonify({"success": False, "error": "items is empty"}), 400

    try:
        sale, amount = lightspeed.create_parked_sale_for_payment(register_id, items, user_id=payload.get("user_id"))
    except lightspeed.LightspeedError as err:
        return jsonify({"success": False, "error": err.message}), err.status_code

    sale_id = sale.get("id")
    return jsonify({
        "success": True,
        "sale_id": sale_id,
        "amount": amount,
        "redirect_url": lightspeed.build_redirect_url(sale_id, action="pay"),
    })


@app.route("/api/checkout/return", methods=["POST", "OPTIONS"])
def checkout_return():
    """Goods return - till-side, not tied to the original receipt. See
    lightspeed.create_return_sale for how negative quantities work."""
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    method = payload.get("method") or "cash"
    register_id = _checkout_register_id(payload)

    if not register_id:
        return jsonify({"success": False, "error": "register_id missing (set LIGHTSPEED_REGISTER_ID in .env)"}), 400
    if not items:
        return jsonify({"success": False, "error": "items is empty"}), 400
    if method not in ("cash", "card"):
        return jsonify({"success": False, "error": "method must be 'cash' or 'card'"}), 400

    try:
        sale, amount = lightspeed.create_return_sale(register_id, items, method=method, user_id=payload.get("user_id"))
    except lightspeed.LightspeedError as err:
        return jsonify({"success": False, "error": err.message}), err.status_code

    return jsonify({"success": True, "sale_id": sale.get("id"), "amount": amount})


@app.route("/api/checkout/voucher", methods=["POST", "OPTIONS"])
def checkout_voucher():
    """Redeem a gift voucher/card as payment for the current cart."""
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    register_id = _checkout_register_id(payload)

    if not register_id:
        return jsonify({"success": False, "error": "register_id missing (set LIGHTSPEED_REGISTER_ID in .env)"}), 400
    if not items:
        return jsonify({"success": False, "error": "items is empty"}), 400

    try:
        sale, amount = lightspeed.create_voucher_sale(
            register_id, items, voucher_code=payload.get("voucher_code"), user_id=payload.get("user_id")
        )
    except lightspeed.LightspeedError as err:
        return jsonify({"success": False, "error": err.message}), err.status_code

    return jsonify({"success": True, "sale_id": sale.get("id"), "amount": amount})


@app.route("/api/holds", methods=["GET"])
def list_holds():
    """ON HOLD / OPEN SALE picker. Held sales are kept locally in this
    backend (not as Lightspeed parked sales) - there's no reliable way to
    list parked sales back from Lightspeed for a given register, and
    checkout already re-validates every price against Lightspeed at the
    point of sale regardless of where the cart data came from."""
    with holds_lock:
        holds = load_holds()
    summaries = []
    for hold in holds:
        total = sum((item.get("price") or 0) * (item.get("quantity") or 0) for item in hold.get("items", []))
        summaries.append({
            "id": hold["id"],
            "created_at": hold["created_at"],
            "item_count": len(hold.get("items", [])),
            "total": round(total, 2),
        })
    return jsonify({"holds": summaries})


@app.route("/api/holds", methods=["POST", "OPTIONS"])
def create_hold():
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    if not items:
        return jsonify({"success": False, "error": "items is empty"}), 400

    hold = {"id": uuid.uuid4().hex[:8], "created_at": time.time(), "items": items}
    with holds_lock:
        holds = load_holds()
        holds.append(hold)
        save_holds(holds)

    return jsonify({"success": True, "id": hold["id"]})


@app.route("/api/holds/<hold_id>", methods=["GET"])
def get_hold(hold_id):
    with holds_lock:
        holds = load_holds()
    hold = next((h for h in holds if h["id"] == hold_id), None)
    if not hold:
        return jsonify({"found": False}), 404
    return jsonify({"found": True, "hold": hold})


@app.route("/api/holds/<hold_id>", methods=["DELETE", "OPTIONS"])
def delete_hold(hold_id):
    if request.method == "OPTIONS":
        return "", 204

    with holds_lock:
        holds = load_holds()
        remaining = [h for h in holds if h["id"] != hold_id]
        if len(remaining) == len(holds):
            return jsonify({"success": False, "error": "hold not found"}), 404
        save_holds(remaining)

    return jsonify({"success": True})


@app.route("/api/sale/<sale_id>", methods=["GET"])
def sale_status(sale_id):
    """Poll after opening the card redirect_url, to know when Lightspeed
    has closed the sale (payment done) so the till app can show the next
    customer's screen."""
    try:
        sale = lightspeed.get_sale(sale_id)
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code
    return jsonify({"id": sale.get("id"), "state": sale.get("state")})


@app.route("/api/sales/recent", methods=["GET"])
def recent_sales():
    """Settings > Invoices card - the last 10 closed sales, newest first."""
    limit = request.args.get("limit", default=10, type=int)
    try:
        sales = lightspeed.list_recent_sales(limit=limit)
    except lightspeed.LightspeedError as err:
        return jsonify({"error": err.message}), err.status_code

    return jsonify({"sales": [
        {
            "id": s.get("id"),
            "date": s.get("sale_date"),
            "total": s.get("total_price"),
            "status": s.get("status"),
        }
        for s in sales
    ]})


@app.route("/api/face/register", methods=["POST", "OPTIONS"])
def register():
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    employee_id = payload.get("employeeId")
    images = payload.get("images") or []

    if not employee_id or not images:
        return jsonify({"success": False, "error": "employeeId and images are required"}), 400

    new_encodings = []
    for data_url in images:
        rgb = decode_image(data_url)
        if rgb is None:
            continue
        encoding = encode_largest_face(rgb)
        if encoding is not None:
            new_encodings.append(encoding.tolist())

    if len(new_encodings) < 3:
        return jsonify({
            "success": False,
            "error": "Could not detect a clear face in enough photos ({}/{} usable)".format(
                len(new_encodings), len(images)
            ),
        }), 422

    with data_lock:
        known = load_known_faces()
        known[employee_id] = known.get(employee_id, []) + new_encodings
        save_known_faces(known)

    return jsonify({"success": True, "count": len(new_encodings)})


@app.route("/api/face/recognize", methods=["POST", "OPTIONS"])
def recognize():
    if request.method == "OPTIONS":
        return "", 204

    payload = request.get_json(force=True, silent=True) or {}
    data_url = payload.get("image")
    if not data_url:
        return jsonify({"matched": False, "error": "image is required"}), 400

    rgb = decode_image(data_url)
    if rgb is None:
        return jsonify({"matched": False, "error": "invalid image"}), 400

    encoding = encode_largest_face(rgb)
    if encoding is None:
        return jsonify({"matched": False, "reason": "no_face"})

    with data_lock:
        known = load_known_faces()

    best_id = None
    best_distance = None
    for employee_id, encodings in known.items():
        if not encodings:
            continue
        distances = face_recognition.face_distance(np.array(encodings), encoding)
        min_dist = float(np.min(distances))
        if best_distance is None or min_dist < best_distance:
            best_distance = min_dist
            best_id = employee_id

    if best_id is not None and best_distance is not None and best_distance <= MATCH_TOLERANCE:
        return jsonify({"matched": True, "employeeId": best_id, "distance": best_distance})

    return jsonify({"matched": False, "reason": "no_match", "distance": best_distance})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False)
