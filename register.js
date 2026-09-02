    /* ============================================================
       EMPLOYEE REGISTRATION SCREEN (script)
       Handles Login <-> Register navigation, the auto-generated
       AMS-#### employee id, the 4-digit PIN fields and the selfie
       camera capture.
       ============================================================ */

    // ---- Auto-generated Employee ID (AMS-0001 style, persisted client-side) ----
    var REG_ID_KEY = 'amsonsNextEmployeeId';
    function peekNextId() {
        var n = parseInt(localStorage.getItem(REG_ID_KEY), 10);
        if (!n || n < 1) n = 1;
        return n;
    }
    function formatId(n) {
        return String(n).padStart(4, '0');
    }
    function showNextId() {
        document.getElementById('regIdNumber').textContent = formatId(peekNextId());
    }
    function commitNextId() {
        var n = peekNextId();
        localStorage.setItem(REG_ID_KEY, String(n + 1));
        return n;
    }

    // ---- Navigation between Login <-> Register ----
    var loginScreenEl = document.getElementById('loginScreen');
    var registerScreenEl = document.getElementById('registerScreen');

    document.getElementById('goRegisterBtn').addEventListener('click', function () {
        showNextId();
        loginScreenEl.style.display = 'none';
        registerScreenEl.style.display = 'flex';
    });

    document.getElementById('backToLoginBtn').addEventListener('click', function () {
        stopCamera();
        registerScreenEl.style.display = 'none';
        loginScreenEl.style.display = 'flex';
        usernameInput.focus();
        activeField = usernameInput;
    });

    // ---- Field focus tracking for the register form (shares the same
    //      "activeField" variable the login screen's keypad/OSK use) ----
    var regName = document.getElementById('regName');
    var regEmail = document.getElementById('regEmail');
    var regPassword = document.getElementById('regPassword');
    var regConfirmPassword = document.getElementById('regConfirmPassword');
    [regName, regEmail, regPassword, regConfirmPassword].forEach(function (el) {
        el.addEventListener('focus', function () { activeField = el; });
    });

    // ---- PIN visibility toggles ----
    function wireEye(btnId, iconId, input) {
        document.getElementById(btnId).addEventListener('click', function () {
            var isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            document.getElementById(iconId).innerHTML =
                '<use href="' + (isHidden ? '#i-eye-off' : '#i-eye') + '"/>';
        });
    }
    wireEye('regToggleEye1', 'regEyeIcon1', regPassword);
    wireEye('regToggleEye2', 'regEyeIcon2', regConfirmPassword);

    // ---- Selfie camera capture: guided multi-angle Face ID enrollment.
    //      Several photos from different angles give the recognition
    //      backend a much more accurate/robust model per employee than
    //      a single shot. ----
    var FACE_STEPS = [
        'Look straight at the camera',
        'Slowly turn your head to the LEFT',
        'Slowly turn your head to the RIGHT',
        'Tilt your head UP a little',
        'Tilt your head DOWN a little'
    ];

    var selfieVideo = document.getElementById('selfieVideo');
    var selfieImg = document.getElementById('selfieImg');
    var selfiePlaceholder = document.getElementById('selfiePlaceholder');
    var selfieStepRow = document.getElementById('selfieStepRow');
    var selfieStepText = document.getElementById('selfieStepText');
    var selfieDots = document.getElementById('selfieDots');
    var cameraStream = null;
    var selfieDataUrls = [];
    var cameraErrored = false;

    selfieDots.innerHTML = FACE_STEPS.map(function () { return '<span class="selfie-dot"></span>'; }).join('');

    function stopCamera() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(function (t) { t.stop(); });
            cameraStream = null;
        }
    }

    function updateStepUi() {
        var step = selfieDataUrls.length;
        selfieDots.querySelectorAll('.selfie-dot').forEach(function (dot, i) {
            dot.classList.toggle('done', i < step);
        });
        if (step < FACE_STEPS.length) {
            selfieStepText.textContent = 'Step ' + (step + 1) + ' of ' + FACE_STEPS.length + ': ' + FACE_STEPS[step];
            document.getElementById('captureBtn').textContent = 'CAPTURE PHOTO ' + (step + 1) + ' / ' + FACE_STEPS.length;
        }
    }

    function startCamera() {
        var status = document.getElementById('cameraStatus');
        status.textContent = 'Opening camera...';
        status.classList.remove('ok');

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            cameraErrored = true;
            status.textContent = 'Camera not supported on this device/browser.';
            return;
        }

        navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' },
            audio: false
        }).then(function (stream) {
            cameraStream = stream;
            selfieVideo.srcObject = stream;
            selfiePlaceholder.style.display = 'none';
            selfieImg.style.display = 'none';
            selfieVideo.style.display = 'block';
            selfieStepRow.style.display = 'flex';
            document.getElementById('startRow').style.display = 'none';
            document.getElementById('captureRow').style.display = 'flex';
            document.getElementById('retakeRow').style.display = 'none';
            status.textContent = '';
            updateStepUi();
        }).catch(function (err) {
            cameraErrored = true;
            status.textContent = 'Camera unavailable: ' + err.message;
        });
    }

    document.getElementById('startCameraBtn').addEventListener('click', startCamera);

    document.getElementById('captureBtn').addEventListener('click', function () {
        var canvas = document.createElement('canvas');
        canvas.width = selfieVideo.videoWidth;
        canvas.height = selfieVideo.videoHeight;
        canvas.getContext('2d').drawImage(selfieVideo, 0, 0, canvas.width, canvas.height);
        selfieDataUrls.push(canvas.toDataURL('image/jpeg', 0.92));

        var status = document.getElementById('cameraStatus');

        if (selfieDataUrls.length >= FACE_STEPS.length) {
            selfieImg.src = selfieDataUrls[0];
            selfieVideo.style.display = 'none';
            selfieImg.style.display = 'block';
            stopCamera();
            selfieStepRow.style.display = 'none';
            document.getElementById('captureRow').style.display = 'none';
            document.getElementById('retakeRow').style.display = 'flex';
            status.textContent = '✔ ' + selfieDataUrls.length + ' photos captured for Face ID';
            status.classList.add('ok');
        } else {
            updateStepUi();
            status.textContent = '✔ Photo ' + selfieDataUrls.length + ' captured';
            status.classList.add('ok');
        }
    });

    document.getElementById('retakeBtn').addEventListener('click', function () {
        selfieDataUrls = [];
        var status = document.getElementById('cameraStatus');
        status.textContent = '';
        status.classList.remove('ok');
        startCamera();
    });

    function resetSelfie() {
        stopCamera();
        selfieDataUrls = [];
        cameraErrored = false;
        selfieVideo.style.display = 'none';
        selfieImg.style.display = 'none';
        selfiePlaceholder.style.display = 'flex';
        selfieStepRow.style.display = 'none';
        document.getElementById('startRow').style.display = 'flex';
        document.getElementById('captureRow').style.display = 'none';
        document.getElementById('retakeRow').style.display = 'none';
        updateStepUi();
        var status = document.getElementById('cameraStatus');
        status.textContent = '';
        status.classList.remove('ok');
    }

    // ---- Register form submit ----
    var registerForm = document.getElementById('registerForm');
    var registerBtn = document.getElementById('registerBtn');
    var registerStatus = document.getElementById('registerStatus');

    function regError(msg) {
        registerStatus.textContent = msg;
        registerStatus.classList.remove('ok');
        registerBtn.classList.add('error');
        setTimeout(function () { registerBtn.classList.remove('error'); }, 500);
    }

    registerForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = regName.value.trim();
        var email = regEmail.value.trim();
        var pass = regPassword.value.trim();
        var confirm = regConfirmPassword.value.trim();

        if (!name) { regError('Please enter your full name'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { regError('Please enter a valid email'); return; }
        if (!/^\d{4}$/.test(pass)) { regError('Password must be exactly 4 digits'); return; }
        if (pass !== confirm) { regError('Passwords do not match'); return; }
        if (selfieDataUrls.length < FACE_STEPS.length && !cameraErrored) {
            regError('Please capture all ' + FACE_STEPS.length + ' Face ID photos');
            return;
        }

        var idNum = commitNextId();
        var newId = 'AMS-' + formatId(idNum);

        var users = JSON.parse(localStorage.getItem('amsonsUsers') || '[]');
        users.push({ id: newId, name: name, email: email, password: pass, photo: selfieDataUrls[0] || null });
        localStorage.setItem('amsonsUsers', JSON.stringify(users));

        function finishRegistration(message) {
            registerStatus.classList.add('ok');
            registerStatus.textContent = message;
            setTimeout(function () {
                registerForm.reset();
                resetSelfie();
                registerStatus.textContent = '';
                registerStatus.classList.remove('ok');

                registerScreenEl.style.display = 'none';
                loginScreenEl.style.display = 'flex';
                usernameInput.value = formatId(idNum);
                passwordInput.value = '';
                passwordInput.focus();
                activeField = passwordInput;
            }, 1400);
        }

        if (selfieDataUrls.length) {
            registerStatus.classList.remove('ok');
            registerStatus.textContent = 'Training Face ID...';
            fetch(TILL_API_BASE + '/api/face/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ employeeId: newId, images: selfieDataUrls })
            }).then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.success) {
                    finishRegistration('✔ Registered as ' + newId + ' — Face ID ready. Redirecting...');
                } else {
                    finishRegistration('✔ Registered as ' + newId + ' — Face ID setup failed (' + (data.error || 'unknown error') + ')');
                }
            }).catch(function () {
                finishRegistration('✔ Registered as ' + newId + ' — Face ID server unreachable, password login only.');
            });
        } else {
            finishRegistration('✔ Registered as ' + newId + ' — redirecting to login...');
        }
    });
