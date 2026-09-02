    /* ============================================================
       TILL DASHBOARD SCREEN (script)
       (the header clock itself is handled by updateLoginClock() below,
       which updates every ".header-time .date"/".time" pair in the
       document - including this screen's)
       ============================================================ */

    // ---- Shared backend base URL (also declared in login.js) - this
    //      script loads first and calls loadQuickAccess() immediately
    //      below, so it needs its own copy rather than relying on
    //      login.js's var to have run yet. ----
    var TILL_API_BASE = 'http://127.0.0.1:5001';

    // ---- Till number, per branch ----
    // Each branch has its own pool of till numbers. The first person to
    // open a till on a branch today is TILL # 1; if a second person
    // opens a till on that *same* branch while the first is still
    // logged in, they get TILL # 2, and so on. Numbers are tracked in
    // localStorage (shared by every tab in this browser, standing in
    // for "every till terminal at this branch") as { branchName: [used
    // numbers] }; this tab's own assignment is kept in sessionStorage
    // so a page reload doesn't hand it a second number, and it's
    // released back to the pool when this tab/till closes.
    var TILLS_MAP_KEY = 'amsonsActiveTills';
    var SESSION_TILL_KEY = 'amsonsSessionTill';

    function getActiveTillsMap() {
        try { return JSON.parse(localStorage.getItem(TILLS_MAP_KEY)) || {}; }
        catch (e) { return {}; }
    }

    function releaseTillNumber(branchName, num) {
        if (!branchName || !num) return;
        var map = getActiveTillsMap();
        var used = map[branchName] || [];
        var idx = used.indexOf(num);
        if (idx !== -1) {
            used.splice(idx, 1);
            map[branchName] = used;
            localStorage.setItem(TILLS_MAP_KEY, JSON.stringify(map));
        }
    }

    function getSessionTill() {
        try { return JSON.parse(sessionStorage.getItem(SESSION_TILL_KEY)); }
        catch (e) { return null; }
    }

    function assignTillNumber(branchName) {
        // Release whatever till number this tab was previously holding
        // (e.g. it logged out and is opening a till on a branch again).
        var prev = getSessionTill();
        if (prev) releaseTillNumber(prev.branch, prev.num);

        var map = getActiveTillsMap();
        var used = map[branchName] || [];
        var n = 1;
        while (used.indexOf(n) !== -1) n++;
        used.push(n);
        map[branchName] = used;
        localStorage.setItem(TILLS_MAP_KEY, JSON.stringify(map));
        sessionStorage.setItem(SESSION_TILL_KEY, JSON.stringify({ branch: branchName, num: n }));
        return n;
    }

    // Free the till number back to its branch's pool when this tab/till
    // is closed, so the next person to open a till on that branch can
    // reuse it.
    window.addEventListener('pagehide', function () {
        var s = getSessionTill();
        if (s) releaseTillNumber(s.branch, s.num);
    });

    // ---- UI sounds: a lightweight Web Audio beep for every button tap and
    //      a harsher two-tone buzz for a failed product scan - synthesized
    //      on the fly so no audio files are needed. The AudioContext is
    //      created lazily on the first tap (autoplay policies require a
    //      user gesture first). ----
    var uiAudioCtx = null;
    function getUiAudioCtx() {
        if (!uiAudioCtx) {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            uiAudioCtx = new Ctx();
        }
        if (uiAudioCtx.state === 'suspended') uiAudioCtx.resume();
        return uiAudioCtx;
    }

    function playTone(freq, duration, volume, type) {
        var ctx = getUiAudioCtx();
        if (!ctx) return;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = type || 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    }

    // Short, quiet "beep" - every button tap on screen.
    function playBeep() {
        playTone(1000, 0.07, 0.18, 'square');
    }

    // Loud, harsh two-tone buzz - product not found / scan failed.
    function playErrorSound() {
        playTone(220, 0.18, 0.5, 'sawtooth');
        setTimeout(function () { playTone(160, 0.28, 0.5, 'sawtooth'); }, 150);
    }

    // Delegated on the document (not just #dashboardScreen) since the
    // keypad modal/category-picker overlays render as siblings of it, and
    // the login/branch/register screens share this same page/scripts too.
    document.addEventListener('click', function (e) {
        if (e.target.closest('button')) playBeep();
    }, true);

    // ---- Keypad "blink" feedback: a bright flash fired on every tap,
    //      so the press always reads clearly even for a very fast tap
    //      (the CSS :active glow alone can be too brief to notice). ----
    document.querySelectorAll('.key-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            btn.classList.remove('flash');
            void btn.offsetWidth; // restart the animation if tapped again quickly
            btn.classList.add('flash');
        });
        btn.addEventListener('animationend', function () {
            btn.classList.remove('flash');
        });
    });

    // ---- Right-sidebar menu: tapping a button flips it to the inverted
    //      gold "selected" look and leaves it that way (switching to
    //      another button clears the old one) so it's clear which tab is
    //      currently active. ----
    document.querySelectorAll('.menu-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.menu-btn.selected').forEach(function (other) {
                if (other !== btn) other.classList.remove('selected');
            });
            btn.classList.toggle('selected');
        });
    });

    /* ============================================================
       CART + CHECKOUT
       Scanning/typing a code looks the product up in Lightspeed
       (Backend/app.py -> Lightspeed X-Series API) and adds it to the
       on-screen cart. CASH SALE closes the sale directly through the
       API. CARD SALE hands the sale off to Lightspeed's own Sell
       screen (Redirect API) so its already-configured Worldpay /
       Lightspeed Payments integration takes the actual card payment -
       this app never touches card data or the terminal.
       ============================================================ */

    var cart = []; // [{ sku, name, price, qty, discountType, discountValue }]
    var dataInput = '';
    var pendingQty = null; // set by "5*" before a scan, to add 5 of the next item
    var selectedLineIndex = null; // cart row tapped to select it, for VOID/DISCOUNT

    var scanCaptureInput = document.getElementById('scanCaptureInput');
    var dataInputCard = document.getElementById('dataInputCard');
    var dataInputValue = document.getElementById('dataInputValue');
    var priceValue = document.getElementById('priceValue');
    var totalQtyValue = document.getElementById('totalQtyValue');
    var totalItemsValue = document.getElementById('totalItemsValue');
    var cartBody = document.getElementById('cartBody');
    var totalAmountValue = document.getElementById('totalAmountValue');
    var amtPayableValue = document.getElementById('amtPayableValue');
    var cashChangeValue = document.getElementById('cashChangeValue');
    var tillToast = document.getElementById('tillToast');
    var cashSaleBtn = document.querySelector('.c-cashsale');
    var cardSaleBtn = document.querySelector('.c-cardsale');

    function money(n) {
        return '£' + (Math.round((n || 0) * 100) / 100).toFixed(2);
    }

    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    // ---- DISCOUNT support: a line keeps its original unit price, plus an
    //      optional discountType/discountValue applied on top of it - see
    //      the DISCOUNT feature below for how those get set. ----
    function lineTotal(line) {
        var base = line.price * line.qty;
        if (!line.discountType || !line.discountValue) return base;
        if (line.discountType === 'percent') return Math.max(0, base * (1 - line.discountValue / 100));
        return Math.max(0, base - line.discountValue);
    }

    function discountTag(line) {
        if (!line.discountType || !line.discountValue) return '';
        var text = line.discountType === 'percent' ? ('-' + line.discountValue + '%') : ('-' + money(line.discountValue));
        return '<span class="line-discount-tag">' + text + '</span>';
    }

    // Cart items as sent to the backend for cash/card/voucher checkout -
    // the backend refetches every price fresh from Lightspeed regardless,
    // it only trusts the discount *instruction* here, never a computed price.
    function cartToItems() {
        return cart.map(function (l) {
            var item = { sku: l.sku, quantity: l.qty };
            if (l.discountType && l.discountValue) item.discount = { type: l.discountType, value: l.discountValue };
            return item;
        });
    }

    // Set via UTILITIES > Select Register; falls back to LIGHTSPEED_REGISTER_ID
    // in the backend's .env when nothing has been picked (see
    // _checkout_register_id in app.py).
    function selectedRegisterId() {
        return localStorage.getItem('amsonsRegisterId') || undefined;
    }

    var toastTimer = null;
    function showToast(message, type) {
        tillToast.textContent = message;
        tillToast.className = 'till-toast show' + (type ? ' ' + type : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { tillToast.classList.remove('show'); }, 2600);
    }

    function flashError(cardEl) {
        cardEl.classList.remove('err-flash');
        void cardEl.offsetWidth; // restart the animation if triggered again quickly
        cardEl.classList.add('err-flash');
    }

    // Full-screen red blink for a declined/voided card payment - impossible
    // to miss even from across the counter.
    function flashAlarm() {
        var el = document.getElementById('alarmFlash');
        if (!el) return;
        el.classList.remove('blink');
        void el.offsetWidth; // restart the animation if triggered again quickly
        el.classList.add('blink');
        setTimeout(function () { el.classList.remove('blink'); }, 2000);
    }

    // Keeps the hidden capture input focused so both the on-screen keypad
    // and a USB barcode scanner (a HID keyboard that types digits + Enter)
    // land in the same DATA INPUT buffer.
    function focusScanCapture() {
        scanCaptureInput.focus({ preventScroll: true });
    }
    document.getElementById('dashboardScreen').addEventListener('click', function (e) {
        if (e.target.tagName !== 'INPUT') focusScanCapture();
    });

    function renderDataInput() {
        dataInputValue.textContent = (pendingQty ? pendingQty + '*' : '') + dataInput;
        scanCaptureInput.value = dataInput;
    }

    function renderCart() {
        cartBody.innerHTML = '';
        var totalQty = 0;
        cart.forEach(function (line, index) {
            totalQty += line.qty;
            var tr = document.createElement('tr');
            tr.dataset.index = index;
            if (index === selectedLineIndex) tr.classList.add('selected-line');
            tr.innerHTML =
                '<td>' + line.sku + '</td>' +
                '<td>' + line.name + discountTag(line) + '</td>' +
                '<td>' + money(line.price) + '</td>' +
                '<td>' + line.qty + '</td>' +
                '<td>' + money(lineTotal(line)) + '</td>';
            cartBody.appendChild(tr);
        });
        cartBody.parentElement.scrollTop = cartBody.parentElement.scrollHeight;

        var total = cart.reduce(function (sum, l) { return sum + lineTotal(l); }, 0);
        totalQtyValue.textContent = totalQty;
        totalItemsValue.textContent = cart.length;
        totalAmountValue.textContent = money(total);
        amtPayableValue.textContent = money(total);
        cashChangeValue.textContent = money(0);
        priceValue.textContent = cart.length ? cart[cart.length - 1].price.toFixed(2) : '0.00';

        cashSaleBtn.classList.toggle('pay-attn', cart.length > 0);
        cardSaleBtn.classList.toggle('pay-attn', cart.length > 0);
    }

    // ---- Tap a cart row to select it (VOID removes it, DISCOUNT targets
    //      it instead of the whole sale); tap again to deselect. ----
    cartBody.addEventListener('click', function (e) {
        var tr = e.target.closest('tr');
        if (!tr) return;
        var idx = parseInt(tr.dataset.index, 10);
        selectedLineIndex = (selectedLineIndex === idx) ? null : idx;
        renderCart();
    });

    function addToCart(product, quantity) {
        quantity = quantity || 1;
        var existing = cart.filter(function (l) { return l.sku === product.sku; })[0];
        if (existing) {
            existing.qty += quantity;
        } else {
            cart.push({ sku: product.sku, name: product.name, price: product.price || 0, qty: quantity });
        }
        renderCart();
    }

    function clearSale() {
        cart = [];
        dataInput = '';
        pendingQty = null;
        selectedLineIndex = null;
        renderDataInput();
        renderCart();
    }

    function lookupAndAddProduct(code, quantity) {
        fetch(TILL_API_BASE + '/api/product/' + encodeURIComponent(code))
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
                if (!result.ok || !result.data.found) {
                    flashError(dataInputCard);
                    playErrorSound();
                    flashAlarm();
                    showToast('Product not found: ' + code, 'error');
                    return;
                }
                addToCart(result.data.product, quantity);
            })
            .catch(function () {
                flashError(dataInputCard);
                playErrorSound();
                flashAlarm();
                showToast('Backend unreachable - is the till server running?', 'error');
            });
    }

    // ---- "5*" then a scan/code adds 5 of that item in one go, instead of
    //      scanning it 5 times. ----
    function commitDataInput() {
        var code = dataInput.trim();
        var quantity = pendingQty || 1;
        dataInput = '';
        pendingQty = null;
        renderDataInput();
        if (code) lookupAndAddProduct(code, quantity);
    }

    function applyMultiplier() {
        var qty = parseInt(dataInput, 10);
        if (!qty || qty < 1) {
            flashError(dataInputCard);
            return;
        }
        pendingQty = qty;
        dataInput = '';
        renderDataInput();
    }

    // ---- On-screen keypad: digits/backspace/back build the DATA INPUT
    //      buffer, ENTER commits it as a barcode lookup, £50/£20/£10 are
    //      quick cash-tender adds, CLEAR SALE empties the whole cart. ----
    document.querySelectorAll('.key-btn[data-key]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var key = btn.getAttribute('data-key');
            if (/^[0-9.]$/.test(key) || key === '00') {
                dataInput += key;
            } else if (key === 'multiply') {
                applyMultiplier();
                focusScanCapture();
                return;
            } else if (key === 'backspace') {
                if (!dataInput && pendingQty !== null) {
                    // undo the "*" - go back to editing the quantity digits
                    dataInput = String(pendingQty);
                    pendingQty = null;
                } else {
                    dataInput = dataInput.slice(0, -1);
                }
            } else if (key === 'clear-entry') {
                dataInput = '';
                pendingQty = null;
            } else if (key === 'enter') {
                commitDataInput();
                focusScanCapture();
                return;
            } else if (key === 'clear-sale') {
                clearSale();
                showToast('Sale cleared', null);
                focusScanCapture();
                return;
            } else if (key === 'cash-50' || key === 'cash-20' || key === 'cash-10') {
                var add = key === 'cash-50' ? 50 : (key === 'cash-20' ? 20 : 10);
                dataInput = ((parseFloat(dataInput) || 0) + add).toFixed(2);
            } else if (key === 'keyboard') {
                openScanKeyboard();
                return;
            }
            renderDataInput();
            focusScanCapture();
        });
    });

    // ---- Physical keyboard / barcode scanner: the scanner types digits
    //      then Enter, exactly like someone typing into this field. ----
    scanCaptureInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitDataInput();
        }
    });
    scanCaptureInput.addEventListener('input', function () {
        dataInput = scanCaptureInput.value;
        renderDataInput(); // keeps the "5*" pending-qty prefix intact
    });

    // ---- On-screen touch keyboard: reuses the login screen's shared OSK
    //      overlay (#oskOverlay in till_amsons.html / wired in login.js),
    //      just pointed at the hidden scan-capture input instead of a
    //      login field. ----
    function openScanKeyboard() {
        activeField = scanCaptureInput;
        document.getElementById('oskOverlay').classList.add('open');
    }

    // ---- CASH SALE: no card terminal involved, so this closes the sale
    //      directly through the backend/Lightspeed API. ----
    document.querySelector('.c-cashsale').addEventListener('click', function () {
        if (!cart.length) { showToast('Cart is empty', 'error'); return; }

        var tendered = parseFloat(dataInput);

        fetch(TILL_API_BASE + '/api/checkout/cash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: cartToItems(),
                tendered_amount: isNaN(tendered) ? null : tendered,
                register_id: selectedRegisterId()
            })
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
            if (!result.ok || !result.data.success) {
                showToast('Cash sale failed: ' + (result.data.error || 'unknown error'), 'error');
                return;
            }
            if (result.data.change_due !== null && result.data.change_due !== undefined) {
                cashChangeValue.textContent = money(result.data.change_due);
            }
            showToast('Cash sale complete - ' + money(result.data.amount), 'ok');
            setTimeout(clearSale, 15000);
        }).catch(function () {
            showToast('Backend unreachable - is the till server running?', 'error');
        });
    });

    // ---- CARD SALE: park the sale in Lightspeed, then hand off to
    //      Lightspeed's own Sell screen (Redirect API) to actually take
    //      the card payment. Polls until Lightspeed closes the sale. ----
    document.querySelector('.c-cardsale').addEventListener('click', function () {
        if (!cart.length) { showToast('Cart is empty', 'error'); return; }

        fetch(TILL_API_BASE + '/api/checkout/card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: cartToItems(), register_id: selectedRegisterId() })
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
            if (!result.ok || !result.data.success) {
                showToast('Card sale failed: ' + (result.data.error || 'unknown error'), 'error');
                return;
            }
            showToast('Complete the tap/insert on the Lightspeed screen...', null);
            var popupW = 480, popupH = 760;
            var popupLeft = Math.max(0, (screen.width - popupW) / 2);
            var popupTop = Math.max(0, (screen.height - popupH) / 2);
            var paymentPopup = window.open(
                result.data.redirect_url,
                'lightspeedPayment',
                'width=' + popupW + ',height=' + popupH + ',left=' + popupLeft + ',top=' + popupTop +
                ',toolbar=no,menubar=no,location=no,status=no,resizable=yes'
            );
            pollSaleStatus(result.data.sale_id, paymentPopup);
        }).catch(function () {
            showToast('Backend unreachable - is the till server running?', 'error');
        });
    });

    function pollSaleStatus(saleId, paymentPopup) {
        var attempts = 0;
        var timer = setInterval(function () {
            attempts++;
            fetch(TILL_API_BASE + '/api/sale/' + saleId)
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data.state === 'closed') {
                        clearInterval(timer);
                        if (paymentPopup && !paymentPopup.closed) paymentPopup.close();
                        showToast('Card payment approved', 'ok');
                        clearSale();
                    } else if (data.state === 'voided') {
                        clearInterval(timer);
                        if (paymentPopup && !paymentPopup.closed) paymentPopup.close();
                        showToast('Card sale was voided', 'error');
                        flashAlarm();
                    } else if (attempts > 90) { // ~3 minutes at 2s intervals
                        clearInterval(timer);
                    }
                })
                .catch(function () { /* transient network blip - keep polling */ });
        }, 2000);
    }

    /* ============================================================
       VOID / DISCOUNT / ON HOLD / OPEN SALE / GOODS RETURN / INQUIRY /
       VOUCHER / UTILITIES
       VOID and DISCOUNT act on the in-memory cart directly (nothing has
       reached Lightspeed yet at this point - checkout is what closes the
       sale). The rest share one generic modal (#actionModalOverlay in
       till_amsons.html) whose body swaps per feature.
       ============================================================ */

    // ---- VOID: removes the selected cart line. Nothing to undo on the
    //      Lightspeed side since checkout hasn't happened yet. ----
    document.querySelector('.c-void').addEventListener('click', function () {
        if (selectedLineIndex === null || !cart[selectedLineIndex]) {
            showToast('Select an item to void first', 'error');
            return;
        }
        cart.splice(selectedLineIndex, 1);
        selectedLineIndex = null;
        renderCart();
        showToast('Item voided', null);
    });

    // ---- Generic sidebar-action modal shell ----
    var actionModalOverlay = document.getElementById('actionModalOverlay');
    var actionModalTitle = document.getElementById('actionModalTitle');
    var actionModalBody = document.getElementById('actionModalBody');

    function openActionModal(title, bodyHtml) {
        actionModalTitle.textContent = title;
        actionModalBody.innerHTML = bodyHtml;
        actionModalOverlay.classList.add('open');
    }

    function closeActionModal() {
        actionModalOverlay.classList.remove('open');
        actionModalBody.innerHTML = '';
        focusScanCapture();
    }

    document.getElementById('actionModalCloseBtn').addEventListener('click', closeActionModal);
    actionModalOverlay.addEventListener('click', function (e) {
        if (e.target === actionModalOverlay) closeActionModal();
    });

    // ---- DISCOUNT: applies Lightspeed's native line-item discount (a
    //      tax-inclusive currency amount, see lightspeed.py's
    //      _build_line_items) to the selected line, or spreads it across
    //      every line if none is selected. ----
    var discountInput = '';

    function discountModalHtml() {
        var target = (selectedLineIndex !== null && cart[selectedLineIndex]) ? cart[selectedLineIndex].name : 'WHOLE SALE';
        var digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
        var keys = digits.map(function (d) {
            var label = d === 'back' ? '⌫' : d;
            return '<button type="button" data-action="discount-digit" data-digit="' + d + '">' + label + '</button>';
        }).join('');
        return '<div class="am-section">' +
            '<div class="am-target">Target: ' + target + '</div>' +
            '<input class="am-field" id="discountValueField" readonly value="">' +
            '<div class="am-keypad">' + keys + '</div>' +
            '<div class="am-btn-row">' +
                '<button type="button" class="am-btn primary" data-action="discount-percent">% OFF</button>' +
                '<button type="button" class="am-btn primary" data-action="discount-amount">£ OFF</button>' +
            '</div>' +
            '<button type="button" class="am-btn danger" data-action="discount-clear">CLEAR DISCOUNT</button>' +
            '</div>';
    }

    function updateDiscountField() {
        var el = document.getElementById('discountValueField');
        if (el) el.value = discountInput;
    }

    function applyDiscount(type) {
        var raw = parseFloat(discountInput);
        if (!raw || raw <= 0) { showToast('Enter a discount amount first', 'error'); return; }

        if (selectedLineIndex !== null && cart[selectedLineIndex]) {
            cart[selectedLineIndex].discountType = type;
            cart[selectedLineIndex].discountValue = raw;
        } else if (type === 'percent') {
            cart.forEach(function (l) { l.discountType = 'percent'; l.discountValue = raw; });
        } else {
            // Flat £ off the whole sale, prorated across lines by each
            // line's share of the pre-discount subtotal.
            var subtotal = cart.reduce(function (s, l) { return s + l.price * l.qty; }, 0);
            cart.forEach(function (l) {
                var share = subtotal ? (l.price * l.qty) / subtotal : 0;
                l.discountType = 'amount';
                l.discountValue = round2(raw * share);
            });
        }
        closeActionModal();
        renderCart();
        showToast('Discount applied', 'ok');
    }

    function clearDiscount() {
        if (selectedLineIndex !== null && cart[selectedLineIndex]) {
            delete cart[selectedLineIndex].discountType;
            delete cart[selectedLineIndex].discountValue;
        } else {
            cart.forEach(function (l) { delete l.discountType; delete l.discountValue; });
        }
        closeActionModal();
        renderCart();
        showToast('Discount cleared', null);
    }

    document.querySelector('.c-discount').addEventListener('click', function () {
        if (!cart.length) { showToast('Cart is empty', 'error'); return; }
        discountInput = '';
        openActionModal('DISCOUNT', discountModalHtml());
    });

    // ---- ON HOLD / OPEN SALE: held sales live in the backend's local
    //      till_data/held_sales.json (not as Lightspeed parked sales - see
    //      /api/holds in app.py for why). Restoring one just repopulates
    //      the on-screen cart; checkout still re-validates every price
    //      against Lightspeed regardless of where the cart came from. ----
    document.querySelector('.c-hold').addEventListener('click', function () {
        if (!cart.length) { showToast('Cart is empty', 'error'); return; }
        var items = cart.map(function (l) {
            var item = { sku: l.sku, name: l.name, price: l.price, quantity: l.qty };
            if (l.discountType && l.discountValue) {
                item.discountType = l.discountType;
                item.discountValue = l.discountValue;
            }
            return item;
        });
        fetch(TILL_API_BASE + '/api/holds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: items })
        }).then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) { showToast('Could not hold sale', 'error'); return; }
            showToast('Sale put on hold', 'ok');
            clearSale();
        }).catch(function () { showToast('Backend unreachable - is the till server running?', 'error'); });
    });

    document.querySelector('.c-opensale').addEventListener('click', openHeldSalesModal);

    function openHeldSalesModal() {
        openActionModal('OPEN SALE', '<div class="am-list" id="heldSalesList"><div class="am-empty">Loading…</div></div>');
        fetch(TILL_API_BASE + '/api/holds')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var list = document.getElementById('heldSalesList');
                if (!list) return; // modal was closed before this resolved
                var holds = data.holds || [];
                if (!holds.length) { list.innerHTML = '<div class="am-empty">No held sales</div>'; return; }
                list.innerHTML = holds.map(function (h) {
                    var when = new Date(h.created_at * 1000).toLocaleTimeString();
                    return '<button type="button" class="am-row" data-action="hold-open" data-hold-id="' + h.id + '">' +
                        '<span>' + when + '<span class="am-row-sub"> · ' + h.item_count + ' item(s)</span></span>' +
                        '<span class="am-row-value">' + money(h.total) + '</span>' +
                        '</button>';
                }).join('');
            })
            .catch(function () {
                var list = document.getElementById('heldSalesList');
                if (list) list.innerHTML = '<div class="am-empty">Backend unreachable</div>';
            });
    }

    function openHeldSale(holdId) {
        if (cart.length) { showToast('Clear or hold the current sale first', 'error'); return; }
        fetch(TILL_API_BASE + '/api/holds/' + encodeURIComponent(holdId))
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.found) { showToast('Hold not found', 'error'); return; }
                data.hold.items.forEach(function (item) {
                    cart.push({
                        sku: item.sku, name: item.name, price: item.price, qty: item.quantity,
                        discountType: item.discountType, discountValue: item.discountValue
                    });
                });
                renderCart();
                closeActionModal();
                showToast('Held sale restored', 'ok');
                fetch(TILL_API_BASE + '/api/holds/' + encodeURIComponent(holdId), { method: 'DELETE' }).catch(function () {});
            })
            .catch(function () { showToast('Backend unreachable', 'error'); });
    }

    // ---- GOODS RETURN: a till-side ("blind") return, not tied to the
    //      original receipt - see lightspeed.create_return_sale. Uses its
    //      own scratch cart so it never touches the live sale in progress. ----
    var returnCart = [];

    document.querySelector('.c-return').addEventListener('click', function () {
        returnCart = [];
        openActionModal('GOODS RETURN', returnModalHtml());
        focusReturnInput();
    });

    function returnModalHtml() {
        return '<div class="am-section">' +
            '<div class="am-scan-row">' +
                '<input class="am-field" id="returnScanInput" placeholder="Scan or type code" autocomplete="off">' +
                '<button type="button" class="am-btn primary" data-action="return-scan">ADD</button>' +
            '</div>' +
            '<div class="am-list" id="returnList"><div class="am-empty">No items scanned yet</div></div>' +
            '<div class="am-btn-row">' +
                '<button type="button" class="am-btn primary" data-action="return-refund" data-method="cash">REFUND CASH</button>' +
                '<button type="button" class="am-btn primary" data-action="return-refund" data-method="card">REFUND CARD*</button>' +
            '</div>' +
            '<div class="am-row-sub">*Records the refund in Lightspeed only - process the actual refund on the card terminal yourself.</div>' +
            '</div>';
    }

    function focusReturnInput() {
        var el = document.getElementById('returnScanInput');
        if (el) el.focus();
    }

    function commitReturnScan() {
        var input = document.getElementById('returnScanInput');
        var code = input ? input.value.trim() : '';
        if (!code) return;
        input.value = '';
        fetch(TILL_API_BASE + '/api/product/' + encodeURIComponent(code))
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
                if (!result.ok || !result.data.found) { showToast('Product not found: ' + code, 'error'); return; }
                var product = result.data.product;
                var existing = returnCart.filter(function (l) { return l.sku === product.sku; })[0];
                if (existing) existing.qty += 1;
                else returnCart.push({ sku: product.sku, name: product.name, price: product.price || 0, qty: 1 });
                renderReturnList();
            })
            .catch(function () { showToast('Backend unreachable', 'error'); });
        focusReturnInput();
    }

    function renderReturnList() {
        var list = document.getElementById('returnList');
        if (!list) return;
        if (!returnCart.length) { list.innerHTML = '<div class="am-empty">No items scanned yet</div>'; return; }
        list.innerHTML = returnCart.map(function (line, index) {
            return '<button type="button" class="am-row" data-action="return-void" data-index="' + index + '">' +
                '<span>' + line.name + ' × ' + line.qty + '</span>' +
                '<span class="am-row-value">' + money(line.price * line.qty) + '</span>' +
                '</button>';
        }).join('');
    }

    function submitReturn(method) {
        if (!returnCart.length) { showToast('Scan at least one item', 'error'); return; }
        var items = returnCart.map(function (l) { return { sku: l.sku, quantity: l.qty }; });
        fetch(TILL_API_BASE + '/api/checkout/return', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: items, method: method, register_id: selectedRegisterId() })
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
            if (!result.ok || !result.data.success) {
                showToast('Return failed: ' + (result.data.error || 'unknown error'), 'error');
                return;
            }
            showToast('Refund recorded - ' + money(Math.abs(result.data.amount)), 'ok');
            closeActionModal();
        }).catch(function () { showToast('Backend unreachable', 'error'); });
    }

    // ---- INQUIRY: price lookup only, never touches the cart. ----
    document.querySelector('.c-inquiry').addEventListener('click', function () {
        openActionModal('INQUIRY', inquiryModalHtml());
        var el = document.getElementById('inquiryCodeInput');
        if (el) el.focus();
    });

    function inquiryModalHtml() {
        return '<div class="am-section">' +
            '<div class="am-scan-row">' +
                '<input class="am-field" id="inquiryCodeInput" placeholder="Scan or type code" autocomplete="off">' +
                '<button type="button" class="am-btn primary" data-action="inquiry-lookup">LOOK UP</button>' +
            '</div>' +
            '<div class="am-empty" id="inquiryResult">Scan an item to see its price</div>' +
            '</div>';
    }

    function commitInquiry() {
        var input = document.getElementById('inquiryCodeInput');
        var code = input ? input.value.trim() : '';
        if (!code) return;
        var resultEl = document.getElementById('inquiryResult');
        fetch(TILL_API_BASE + '/api/product/' + encodeURIComponent(code))
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
                if (!resultEl) return;
                if (!result.ok || !result.data.found) { resultEl.textContent = 'Not found: ' + code; return; }
                var p = result.data.product;
                resultEl.innerHTML = '<strong>' + p.name + '</strong><br>' + money(p.price);
                input.value = '';
                input.focus();
            })
            .catch(function () { if (resultEl) resultEl.textContent = 'Backend unreachable'; });
    }

    // ---- VOUCHER: redeems a gift voucher/card as payment for the current
    //      cart - see lightspeed.create_voucher_sale. ----
    document.querySelector('.c-voucher').addEventListener('click', function () {
        if (!cart.length) { showToast('Cart is empty', 'error'); return; }
        openActionModal('VOUCHER', voucherModalHtml());
        var el = document.getElementById('voucherCodeInput');
        if (el) el.focus();
    });

    function voucherModalHtml() {
        var total = cart.reduce(function (sum, l) { return sum + lineTotal(l); }, 0);
        return '<div class="am-section">' +
            '<div class="am-target">Amount: ' + money(total) + '</div>' +
            '<input class="am-field" id="voucherCodeInput" placeholder="Voucher / gift card code" autocomplete="off">' +
            '<button type="button" class="am-btn primary" data-action="voucher-confirm">REDEEM VOUCHER</button>' +
            '</div>';
    }

    function submitVoucher() {
        var input = document.getElementById('voucherCodeInput');
        var code = input ? input.value.trim() : '';
        fetch(TILL_API_BASE + '/api/checkout/voucher', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: cartToItems(), voucher_code: code || undefined, register_id: selectedRegisterId() })
        }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
            if (!result.ok || !result.data.success) {
                showToast('Voucher sale failed: ' + (result.data.error || 'unknown error'), 'error');
                return;
            }
            showToast('Voucher sale complete - ' + money(result.data.amount), 'ok');
            closeActionModal();
            clearSale();
        }).catch(function () { showToast('Backend unreachable', 'error'); });
    }

    // ---- SETTINGS (formerly UTILITIES): surfaces /api/registers,
    //      /api/payment-types, /api/health/lightspeed and /api/sales/recent
    //      - all already built in app.py - plus a Profile card that edits
    //      the logged-in user's record straight in localStorage's
    //      amsonsUsers (the same store login.js/register.js use; there is
    //      no backend user database for this till app). ----
    document.querySelector('.c-settings').addEventListener('click', openSettingsModal);

    // The logged-in user's typed 4-digit ID lives on in the login screen's
    // #username field for the rest of the session (branch.js's admin-name
    // badge already relies on this same trick) - reused here rather than
    // adding a second, separately-synced "current user" store.
    function getCurrentUser() {
        var idField = document.getElementById('username');
        var typedId = idField ? idField.value.trim() : '';
        if (!typedId) return null;
        var users = JSON.parse(localStorage.getItem('amsonsUsers') || '[]');
        return users.filter(function (u) { return u.id === 'AMS-' + typedId; })[0] || null;
    }

    function saveCurrentUser(updated) {
        var users = JSON.parse(localStorage.getItem('amsonsUsers') || '[]');
        var idx = users.findIndex(function (u) { return u.id === updated.id; });
        if (idx === -1) return;
        users[idx] = updated;
        localStorage.setItem('amsonsUsers', JSON.stringify(users));

        var adminNameEl = document.querySelector('#dashboardScreen .admin-name');
        if (adminNameEl) adminNameEl.textContent = updated.name;
    }

    function avatarInnerHtml(user, editable) {
        var editCls = editable ? ' editable' : '';
        if (user && user.photo) {
            return '<div class="avatar-circle stg-avatar' + editCls + '" id="settingsAvatarBox"><img src="' + user.photo + '" alt=""></div>';
        }
        return '<div class="avatar-circle stg-avatar' + editCls + '" id="settingsAvatarBox"><svg><use href="#i-person"/></svg></div>';
    }

    function openSettingsModal() {
        renderSettingsView();
    }

    function renderSettingsView() {
        var user = getCurrentUser();
        var currentRegister = localStorage.getItem('amsonsRegisterName') || 'Default (.env)';
        var idField = document.getElementById('username');
        var typedId = idField ? idField.value.trim() : '';
        var role = typedId === '0000' ? 'ADMIN' : 'STAFF';

        openActionModal('SETTINGS', '' +
            '<div class="am-list">' +
                '<div class="stg-section-title">PROFILE</div>' +
                '<div class="stg-profile-card">' +
                    avatarInnerHtml(user, false) +
                    '<div class="stg-profile-info">' +
                        '<div class="stg-profile-name">' + (user ? user.name : 'Unknown user') + '</div>' +
                        '<div class="stg-profile-sub">' + (user ? user.email : '') + '</div>' +
                        '<div class="stg-profile-sub">' + (user ? user.id : '') + ' &middot; ' + role + '</div>' +
                    '</div>' +
                    '<button type="button" class="am-btn primary" style="flex:none;" data-action="settings-edit-profile">EDIT</button>' +
                '</div>' +

                '<div class="stg-section-title">INVOICES</div>' +
                '<div id="settingsInvoiceList"><div class="am-empty">Loading&hellip;</div></div>' +

                '<div class="stg-section-title">SYSTEM</div>' +
                '<button type="button" class="am-row" data-action="utility-connection">' +
                    '<span>Lightspeed Connection</span><span class="am-row-value" id="utilConnStatus">Check</span>' +
                '</button>' +
                '<button type="button" class="am-row" data-action="utility-registers">' +
                    '<span>Select Register</span><span class="am-row-sub">' + currentRegister + '</span>' +
                '</button>' +
                '<button type="button" class="am-row" data-action="utility-payment-types">' +
                    '<span>Payment Types</span><span class="am-row-sub">View configured</span>' +
                '</button>' +
            '</div>');

        loadRecentInvoices();
    }

    // ---- Profile edit: name/email/picture always editable, password only
    //      changes if a new one is typed (blank = keep current PIN). ----
    var pendingPhotoDataUrl = null;

    function renderSettingsEdit() {
        var user = getCurrentUser();
        if (!user) { showToast('No logged-in user found', 'error'); renderSettingsView(); return; }
        pendingPhotoDataUrl = null;

        actionModalTitle.textContent = 'EDIT PROFILE';
        actionModalBody.innerHTML = '' +
            '<div class="am-section">' +
                '<div style="display:flex;justify-content:center;">' + avatarInnerHtml(user, true) + '</div>' +
                '<input type="file" accept="image/*" id="settingsPhotoInput" style="display:none;">' +

                '<div class="stg-field-label">NAME</div>' +
                '<input type="text" class="am-field" id="settingsNameField" value="' + user.name + '">' +

                '<div class="stg-field-label">EMAIL</div>' +
                '<input type="email" class="am-field" id="settingsEmailField" value="' + user.email + '">' +

                '<div class="stg-field-label">NEW PIN (leave blank to keep current)</div>' +
                '<input type="password" class="am-field" id="settingsPinField" maxlength="4" inputmode="numeric" placeholder="&bull;&bull;&bull;&bull;">' +

                '<div class="stg-field-label">CONFIRM NEW PIN</div>' +
                '<input type="password" class="am-field" id="settingsPinConfirmField" maxlength="4" inputmode="numeric" placeholder="&bull;&bull;&bull;&bull;">' +

                '<div class="am-btn-row">' +
                    '<button type="button" class="am-btn ghost" data-action="settings-cancel-edit">CANCEL</button>' +
                    '<button type="button" class="am-btn primary" data-action="settings-save-profile">SAVE</button>' +
                '</div>' +
            '</div>';
    }

    function saveProfileEdit() {
        var user = getCurrentUser();
        if (!user) return;

        var name = (document.getElementById('settingsNameField').value || '').trim();
        var email = (document.getElementById('settingsEmailField').value || '').trim();
        var pin = (document.getElementById('settingsPinField').value || '').trim();
        var pinConfirm = (document.getElementById('settingsPinConfirmField').value || '').trim();

        if (!name) { showToast('Enter a name', 'error'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Enter a valid email', 'error'); return; }
        if (pin || pinConfirm) {
            if (!/^\d{4}$/.test(pin)) { showToast('PIN must be exactly 4 digits', 'error'); return; }
            if (pin !== pinConfirm) { showToast('PINs do not match', 'error'); return; }
        }

        var updated = {
            id: user.id,
            name: name,
            email: email,
            password: pin || user.password,
            photo: pendingPhotoDataUrl || user.photo || null
        };
        saveCurrentUser(updated);
        showToast('Profile updated', 'ok');
        renderSettingsView();
    }

    // ---- INVOICES: last 10 sales pulled from Lightspeed via
    //      /api/sales/recent. ----
    function loadRecentInvoices() {
        fetch(TILL_API_BASE + '/api/sales/recent?limit=10')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var list = document.getElementById('settingsInvoiceList');
                if (!list) return;
                var sales = data.sales || [];
                if (!sales.length) { list.innerHTML = '<div class="am-empty">No invoices yet</div>'; return; }
                list.innerHTML = sales.map(function (s) {
                    return '<div class="stg-invoice-row" style="margin-bottom:0.6vh;">' +
                        '<span>#' + s.id + '<span class="am-row-sub">' + (s.date || '') + '</span></span>' +
                        '<span class="am-row-value">' + money(s.total) + '</span>' +
                    '</div>';
                }).join('');
            })
            .catch(function () {
                var list = document.getElementById('settingsInvoiceList');
                if (list) list.innerHTML = '<div class="am-empty">Backend unreachable</div>';
            });
    }

    function checkLightspeedConnection() {
        var statusEl = document.getElementById('utilConnStatus');
        if (statusEl) statusEl.textContent = 'Checking…';
        fetch(TILL_API_BASE + '/api/health/lightspeed')
            .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
            .then(function (result) {
                if (!statusEl) return;
                statusEl.textContent = result.data.connected ? ('Connected: ' + result.data.retailer) : ('Error: ' + result.data.error);
            })
            .catch(function () { if (statusEl) statusEl.textContent = 'Backend unreachable'; });
    }

    function openRegisterPicker() {
        openActionModal('SELECT REGISTER', '<div class="am-list" id="registerList"><div class="am-empty">Loading…</div></div>');
        fetch(TILL_API_BASE + '/api/registers')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var list = document.getElementById('registerList');
                if (!list) return;
                var registers = data.registers || [];
                if (!registers.length) { list.innerHTML = '<div class="am-empty">No registers found</div>'; return; }
                list.innerHTML = registers.map(function (r) {
                    return '<button type="button" class="am-row" data-action="register-select" data-register-id="' + r.id +
                        '" data-register-name="' + r.name + '"><span>' + r.name + '</span></button>';
                }).join('');
            })
            .catch(function () {
                var list = document.getElementById('registerList');
                if (list) list.innerHTML = '<div class="am-empty">Backend unreachable</div>';
            });
    }

    function selectRegister(id, name) {
        localStorage.setItem('amsonsRegisterId', id);
        localStorage.setItem('amsonsRegisterName', name);
        showToast('Register set to ' + name, 'ok');
        closeActionModal();
    }

    function openPaymentTypesList() {
        openActionModal('PAYMENT TYPES', '<div class="am-list" id="paymentTypesList"><div class="am-empty">Loading…</div></div>');
        fetch(TILL_API_BASE + '/api/payment-types')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var list = document.getElementById('paymentTypesList');
                if (!list) return;
                var types = data.payment_types || [];
                if (!types.length) { list.innerHTML = '<div class="am-empty">None configured</div>'; return; }
                list.innerHTML = types.map(function (t) {
                    return '<div class="am-row" style="cursor:default;"><span>' + t.name + '</span></div>';
                }).join('');
            })
            .catch(function () {
                var list = document.getElementById('paymentTypesList');
                if (list) list.innerHTML = '<div class="am-empty">Backend unreachable</div>';
            });
    }

    // ---- One delegated handler for every clickable control inside the
    //      shared modal, since its body gets replaced per feature. ----
    actionModalBody.addEventListener('click', function (e) {
        var el = e.target.closest('[data-action]');
        if (!el) return;
        var action = el.dataset.action;

        if (action === 'discount-digit') {
            var d = el.dataset.digit;
            if (d === 'back') discountInput = discountInput.slice(0, -1);
            else if (d === '.') { if (discountInput.indexOf('.') === -1) discountInput += '.'; }
            else discountInput += d;
            updateDiscountField();
        } else if (action === 'discount-percent') {
            applyDiscount('percent');
        } else if (action === 'discount-amount') {
            applyDiscount('amount');
        } else if (action === 'discount-clear') {
            clearDiscount();
        } else if (action === 'hold-open') {
            openHeldSale(el.dataset.holdId);
        } else if (action === 'return-scan') {
            commitReturnScan();
        } else if (action === 'return-void') {
            returnCart.splice(parseInt(el.dataset.index, 10), 1);
            renderReturnList();
        } else if (action === 'return-refund') {
            submitReturn(el.dataset.method);
        } else if (action === 'inquiry-lookup') {
            commitInquiry();
        } else if (action === 'voucher-confirm') {
            submitVoucher();
        } else if (action === 'utility-connection') {
            checkLightspeedConnection();
        } else if (action === 'utility-registers') {
            openRegisterPicker();
        } else if (action === 'utility-payment-types') {
            openPaymentTypesList();
        } else if (action === 'register-select') {
            selectRegister(el.dataset.registerId, el.dataset.registerName);
        } else if (action === 'settings-edit-profile') {
            renderSettingsEdit();
        } else if (action === 'settings-cancel-edit') {
            renderSettingsView();
        } else if (action === 'settings-save-profile') {
            saveProfileEdit();
        }
    });

    // ---- Profile picture picker: tapping the (editable) avatar in the
    //      edit-profile form opens the hidden file input; picking an image
    //      reads it into a dataURL (same format register.js's Face ID
    //      selfies use for the "photo" field) and previews it immediately. ----
    actionModalBody.addEventListener('click', function (e) {
        var avatar = e.target.closest('#settingsAvatarBox.editable');
        if (!avatar) return;
        var input = document.getElementById('settingsPhotoInput');
        if (input) input.click();
    });

    actionModalBody.addEventListener('change', function (e) {
        if (e.target.id !== 'settingsPhotoInput') return;
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            pendingPhotoDataUrl = reader.result;
            var avatar = document.getElementById('settingsAvatarBox');
            if (avatar) avatar.innerHTML = '<img src="' + pendingPhotoDataUrl + '" alt="">';
        };
        reader.readAsDataURL(file);
    });

    // Enter key inside the modal's scan/code fields acts like tapping their
    // ADD/LOOK UP button.
    actionModalBody.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (e.target.id === 'returnScanInput') { e.preventDefault(); commitReturnScan(); }
        else if (e.target.id === 'inquiryCodeInput') { e.preventDefault(); commitInquiry(); }
    });

    /* ============================================================
       QUICK PRODUCTS + CATEGORIES
       Pulled live from Lightspeed on every dashboard load - an admin
       tagging a product "Quick Pick" or adding a category in the
       Lightspeed back office shows up here next time the till is opened,
       no redeploy needed. The 4th CATEGORIES slot (NO BARCODE ITEMS) is
       a till function, not a Lightspeed category, so it's left alone.
       ============================================================ */

    var categoryList = [];

    var productsGrid = document.getElementById('productsGrid');
    var catPickerOverlay = document.getElementById('catPickerOverlay');
    var catPickerTitle = document.getElementById('catPickerTitle');
    var catPickerGrid = document.getElementById('catPickerGrid');

    // Whatever comes back gets a button - however many products an admin
    // tags "Quick Pick" in Lightspeed, all of them show up (the grid
    // scrolls internally, see .products-grid's max-height in the CSS).
    function renderQuickPickProducts(products) {
        productsGrid.innerHTML = '';
        if (!products.length) {
            productsGrid.innerHTML = '<div class="cat-picker-empty">Tag products "Quick Pick" in Lightspeed to fill this</div>';
            return;
        }
        products.forEach(function (product) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'prod-btn';
            btn.innerHTML = '<svg class="cat-icon"><use href="#i-trending"/></svg>' + product.name;
            btn.addEventListener('click', function () {
                var quantity = pendingQty || 1;
                pendingQty = null;
                renderDataInput();
                addToCart(product, quantity);
            });
            productsGrid.appendChild(btn);
        });
    }

    function loadQuickAccess() {
        fetch(TILL_API_BASE + '/api/products/quick-picks')
            .then(function (res) { return res.json(); })
            .then(function (data) { renderQuickPickProducts(data.products || []); })
            .catch(function () { /* backend/Lightspeed unreachable - leave grid empty */ });

        fetch(TILL_API_BASE + '/api/categories')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                categoryList = (data.categories || []).slice(0, 3);
                var buttons = document.querySelectorAll('.cat-btn');
                var icons = ['i-menitems', 'i-womenitems', 'i-blackseed'];
                categoryList.forEach(function (category, i) {
                    if (!buttons[i]) return;
                    buttons[i].innerHTML = '<svg class="cat-icon"><use href="#' + icons[i] + '"/></svg>' + category.name;
                });
            })
            .catch(function () { /* backend/Lightspeed unreachable - leave placeholders */ });
    }

    function openCategoryPicker(category) {
        catPickerTitle.textContent = category.name;
        catPickerGrid.innerHTML = '<div class="cat-picker-empty">Loading…</div>';
        catPickerOverlay.classList.add('open');

        fetch(TILL_API_BASE + '/api/categories/' + encodeURIComponent(category.id) + '/products')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                var products = data.products || [];
                if (!products.length) {
                    catPickerGrid.innerHTML = '<div class="cat-picker-empty">No products in this category</div>';
                    return;
                }
                catPickerGrid.innerHTML = '';
                products.forEach(function (product) {
                    var item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'cat-pick-item';
                    item.innerHTML = '<span>' + product.name + '</span>' +
                        '<span class="cat-pick-price">' + money(product.price) + '</span>';
                    item.addEventListener('click', function () {
                        var quantity = pendingQty || 1;
                        pendingQty = null;
                        renderDataInput();
                        addToCart(product, quantity);
                        showToast('Added: ' + product.name, 'ok');
                    });
                    catPickerGrid.appendChild(item);
                });
            })
            .catch(function () {
                catPickerGrid.innerHTML = '<div class="cat-picker-empty">Backend unreachable</div>';
            });
    }

    document.querySelectorAll('.cat-btn').forEach(function (btn, i) {
        btn.addEventListener('click', function () {
            var category = categoryList[i];
            if (!category) return; // slot 4 (NO BARCODE ITEMS) or not yet loaded
            openCategoryPicker(category);
        });
    });

    document.getElementById('catPickerCloseBtn').addEventListener('click', function () {
        catPickerOverlay.classList.remove('open');
    });
    catPickerOverlay.addEventListener('click', function (e) {
        if (e.target === catPickerOverlay) catPickerOverlay.classList.remove('open');
    });

    loadQuickAccess();

    renderCart();
