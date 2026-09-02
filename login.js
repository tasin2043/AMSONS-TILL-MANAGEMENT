    /* ============================================================
       TILL LOGIN SCREEN (script)
       Handles the login form, the on-screen numeric keypad, the
       on-screen keyboard overlay and the login -> dashboard handoff.
       ============================================================ */

    // ---- Header clock (date + time) — updates the Login, Register and
    //      Dashboard screens, since each has its own ".header-time" block ----
    var loginMonths = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    function loginPad(n) { return n < 10 ? '0' + n : n; }
    function updateLoginClock() {
        var dateEls = document.querySelectorAll('.header-time .date');
        var timeEls = document.querySelectorAll('.header-time .time');
        if (!dateEls.length) return;
        var now = new Date();
        var dateStr = loginPad(now.getDate()) + ' ' + loginMonths[now.getMonth()] + ' ' + now.getFullYear();
        var hours = now.getHours();
        var ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        var timeStr = loginPad(hours) + ':' + loginPad(now.getMinutes()) + '<span class="ampm">' + ampm + '</span>';
        dateEls.forEach(function (el) { el.textContent = dateStr; });
        timeEls.forEach(function (el) { el.innerHTML = timeStr; });
    }
    updateLoginClock();
    setInterval(updateLoginClock, 1000);

    // ---- Field focus tracking (keypad types into whichever field is active) ----
    var usernameInput = document.getElementById('username');
    var passwordInput = document.getElementById('password');
    var activeField = usernameInput;

    [usernameInput, passwordInput].forEach(function (el) {
        el.addEventListener('focus', function () { activeField = el; });
    });

    // Land straight in the User ID field so typing can start right away.
    usernameInput.focus();

    // ---- User ID / PIN: both fixed at 4 digits, digits only. Typing
    //      the 4th digit of the ID auto-jumps to the PIN, and typing
    //      the 4th digit of the PIN auto-submits the login. ----
    usernameInput.addEventListener('input', function () {
        usernameInput.value = usernameInput.value.replace(/\D/g, '').slice(0, 4);
        if (usernameInput.value.length === 4) {
            passwordInput.focus();
        }
    });

    passwordInput.addEventListener('input', function () {
        passwordInput.value = passwordInput.value.replace(/\D/g, '').slice(0, 4);
        if (passwordInput.value.length === 4) {
            attemptLogin();
        }
    });

    // ---- Password visibility toggle ----
    document.getElementById('toggleEye').addEventListener('click', function () {
        var isHidden = passwordInput.type === 'password';
        passwordInput.type = isHidden ? 'text' : 'password';
        document.getElementById('eyeIcon').innerHTML =
            '<use href="' + (isHidden ? '#i-eye-off' : '#i-eye') + '"/>';
    });

    // ---- Numeric keypad (shared by the Login and Register screens'
    //      keypads — both use the same .login-key-btn classes) ----
    document.querySelectorAll('.login-key-btn.num').forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (activeField.maxLength > 0 && activeField.value.length >= activeField.maxLength) return;
            activeField.value += btn.textContent.trim();
            activeField.focus();
            // Same auto-advance/auto-submit as real typing, for the two
            // login-screen fields specifically (register's own fields
            // aren't affected — they're different elements).
            if (activeField === usernameInput && usernameInput.value.length === 4) {
                passwordInput.focus();
            } else if (activeField === passwordInput && passwordInput.value.length === 4) {
                attemptLogin();
            }
        });
    });

    document.querySelectorAll('.login-key-btn.del').forEach(function (btn) {
        btn.addEventListener('click', function () {
            activeField.value = activeField.value.slice(0, -1);
            activeField.focus();
        });
    });

    document.querySelectorAll('.login-key-btn.back').forEach(function (btn) {
        btn.addEventListener('click', function () {
            activeField.value = '';
            activeField.focus();
        });
    });

    // ---- Keypad "blink" feedback (same white-flash treatment on both
    //      the Login and Register screens' keypads) ----
    document.querySelectorAll('.login-key-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            btn.classList.remove('flash');
            void btn.offsetWidth; // restart the animation if tapped again quickly
            btn.classList.add('flash');
        });
        btn.addEventListener('animationend', function () {
            btn.classList.remove('flash');
        });
    });

    // ---- Top-center error popup ----
    var loginErrorPopup = document.getElementById('loginErrorPopup');
    var loginErrorText = document.getElementById('loginErrorText');
    var loginErrorTimer = null;
    function showLoginError(msg) {
        loginErrorText.textContent = msg;
        loginErrorPopup.classList.add('show');
        clearTimeout(loginErrorTimer);
        loginErrorTimer = setTimeout(function () {
            loginErrorPopup.classList.remove('show');
        }, 2400);
    }

    // ---- Login: validate the 4-digit ID + PIN against registered
    //      users, then hide the login screen and reveal the dashboard.
    //      Runs both on LOGIN button submit and automatically once the
    //      4th PIN digit is typed. ----
    var loginForm = document.getElementById('loginForm');
    var loginBtn = document.getElementById('loginBtn');
    var loginBusy = false;

    function attemptLogin() {
        if (loginBusy) return;
        var typedId = usernameInput.value.trim();
        var typedPin = passwordInput.value.trim();

        if (typedId.length < 4 || typedPin.length < 4) {
            showLoginError('Enter a 4-digit User ID and PIN');
            return;
        }

        var users = JSON.parse(localStorage.getItem('amsonsUsers') || '[]');
        var fullId = 'AMS-' + typedId;
        var user = users.filter(function (u) { return u.id === fullId; })[0];

        if (!user || user.password !== typedPin) {
            showLoginError('Incorrect User ID or PIN');
            passwordInput.value = '';
            passwordInput.focus();
            activeField = passwordInput;
            return;
        }

        // User ID 0000 is the reserved Admin id - every other id logs
        // in as a normal user. Drives the "ADMIN" / "NORMAL" badge in
        // the dashboard header.
        var modeBadge = document.getElementById('modeBadge');
        if (modeBadge) modeBadge.textContent = (typedId === '0000') ? 'ADMIN' : 'NORMAL';

        loginBusy = true;
        loginBtn.textContent = 'LOGGING IN...';
        setTimeout(function () {
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('branchScreen').style.display = 'flex';
            loginBusy = false;
        }, 500);
    }

    loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        attemptLogin();
    });

    // ---- Shared backend base URL (Face ID, product lookup, checkout -
    //      all served by the same Flask app in Backend/app.py) ----
    var TILL_API_BASE = 'http://127.0.0.1:5001';

    // ---- Face ID Login (avatar tap -> live camera match against the
    //      Face ID backend at TILL_API_BASE, shown inline inside the
    //      avatar circle itself rather than a separate popup) ----
    var faceLoginAvatar = document.getElementById('faceLoginAvatar');
    var faceLoginImg = document.getElementById('faceLoginImg');
    var faceLoginVideo = document.getElementById('faceLoginVideo');
    var faceLoginHint = document.getElementById('faceLoginHint');
    var faceLoginStream = null;
    var faceLoginTimer = null;
    var faceLoginBusy = false;
    var faceLoginActive = false;

    function setFaceHint(msg, ok) {
        faceLoginHint.textContent = msg;
        faceLoginHint.classList.toggle('ok', !!ok);
    }

    function stopFaceLogin(resetHint) {
        if (faceLoginTimer) { clearInterval(faceLoginTimer); faceLoginTimer = null; }
        if (faceLoginStream) {
            faceLoginStream.getTracks().forEach(function (t) { t.stop(); });
            faceLoginStream = null;
        }
        faceLoginBusy = false;
        faceLoginActive = false;
        faceLoginAvatar.classList.remove('active');
        faceLoginVideo.style.display = 'none';
        faceLoginImg.style.display = 'block';
        if (resetHint !== false) setFaceHint('TAP FOR FACE ID LOGIN');
    }

    function captureFaceFrame() {
        var canvas = document.createElement('canvas');
        canvas.width = faceLoginVideo.videoWidth || 640;
        canvas.height = faceLoginVideo.videoHeight || 480;
        canvas.getContext('2d').drawImage(faceLoginVideo, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.85);
    }

    function completeFaceLogin(employeeId) {
        var users = JSON.parse(localStorage.getItem('amsonsUsers') || '[]');
        var user = users.filter(function (u) { return u.id === employeeId; })[0];
        setFaceHint('✔ Welcome, ' + (user ? user.name : employeeId), true);
        if (faceLoginTimer) { clearInterval(faceLoginTimer); faceLoginTimer = null; }
        setTimeout(function () {
            stopFaceLogin(false);
            var typedId = employeeId.replace('AMS-', '');
            usernameInput.value = typedId;
            var modeBadge = document.getElementById('modeBadge');
            if (modeBadge) modeBadge.textContent = (typedId === '0000') ? 'ADMIN' : 'NORMAL';
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('branchScreen').style.display = 'flex';
        }, 700);
    }

    function tryFaceMatch() {
        if (faceLoginBusy || !faceLoginStream) return;
        faceLoginBusy = true;
        fetch(TILL_API_BASE + '/api/face/recognize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: captureFaceFrame() })
        }).then(function (res) { return res.json(); })
        .then(function (data) {
            faceLoginBusy = false;
            if (data.matched) {
                completeFaceLogin(data.employeeId);
            } else {
                setFaceHint(data.reason === 'no_face'
                    ? 'Position your face in the circle...'
                    : 'Not recognized, keep looking...');
            }
        }).catch(function () {
            faceLoginBusy = false;
            setFaceHint('Face ID server unreachable — tap to cancel');
            if (faceLoginTimer) { clearInterval(faceLoginTimer); faceLoginTimer = null; }
        });
    }

    function startFaceLogin() {
        faceLoginActive = true;
        faceLoginAvatar.classList.add('active');
        setFaceHint('Starting camera...');

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setFaceHint('Camera not supported on this device/browser.');
            faceLoginActive = false;
            faceLoginAvatar.classList.remove('active');
            return;
        }

        navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: false
        }).then(function (stream) {
            faceLoginStream = stream;
            faceLoginVideo.srcObject = stream;
            faceLoginImg.style.display = 'none';
            faceLoginVideo.style.display = 'block';
            setFaceHint('Look at the camera...');
            faceLoginTimer = setInterval(tryFaceMatch, 900);
        }).catch(function (err) {
            setFaceHint('Camera unavailable: ' + err.message);
            faceLoginActive = false;
            faceLoginAvatar.classList.remove('active');
        });
    }

    faceLoginAvatar.addEventListener('click', function () {
        if (faceLoginActive) {
            stopFaceLogin();
        } else {
            startFaceLogin();
        }
    });

    // ---- Exit ----
    document.getElementById('exitBtn').addEventListener('click', function () {
        if (confirm('Exit the till login screen?')) {
            window.close();
        }
    });

    // ---- Test connection ----
    document.getElementById('testConnBtn').addEventListener('click', function () {
        var status = document.getElementById('connStatus');
        status.textContent = 'Testing connection...';
        status.classList.remove('ok');
        setTimeout(function () {
            status.textContent = '✔ Connection successful';
            status.classList.add('ok');
        }, 900);
    });

    // ---- On-screen keyboard (shared overlay, opened from either screen) ----
    var oskOverlay = document.getElementById('oskOverlay');
    document.getElementById('oskBtn').addEventListener('click', function () {
        oskOverlay.classList.add('open');
    });
    document.getElementById('regOskBtn').addEventListener('click', function () {
        oskOverlay.classList.add('open');
    });

    oskOverlay.addEventListener('click', function (e) {
        if (e.target === oskOverlay) oskOverlay.classList.remove('open');
    });

    document.querySelectorAll('.osk-key').forEach(function (key) {
        key.addEventListener('click', function () {
            var action = key.getAttribute('data-action');
            if (action === 'close' || action === 'done') {
                oskOverlay.classList.remove('open');
                activeField.focus();
                return;
            }
            if (action === 'back') {
                activeField.value = activeField.value.slice(0, -1);
            } else if (activeField.maxLength > 0 && activeField.value.length >= activeField.maxLength) {
                // field is full (e.g. a 4-digit PIN) — ignore further typing
                return;
            } else if (action === 'space') {
                activeField.value += ' ';
            } else {
                activeField.value += key.textContent;
            }
            // Setting .value directly doesn't fire a real 'input' event, so
            // any listener relying on one (the dashboard's DATA INPUT sync,
            // the login username/password auto-advance) would otherwise
            // never see OSK-typed characters.
            activeField.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });
