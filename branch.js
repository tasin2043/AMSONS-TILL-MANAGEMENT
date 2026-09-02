    /* ============================================================
       CHOOSE YOUR BRANCH SCREEN (script)
       Picking a card opens the dashboard and sets its header badge
       (the small box next to the "Amsons" logo, e.g. "ALUMROCK") to
       that branch's short name.
       ============================================================ */
    document.querySelectorAll('.branch-card').forEach(function (card) {
        card.addEventListener('click', function () {
            var branchName = card.getAttribute('data-badge');
            var badge = document.querySelector('#dashboardScreen .alumrock-box');
            if (badge) badge.textContent = branchName;

            // Show whichever employee actually logged in (matched from
            // the registered users list by their AMS-#### id) instead
            // of a hardcoded name.
            var adminName = 'ADMIN';
            var adminNameEl = document.querySelector('#dashboardScreen .admin-name');
            if (adminNameEl) {
                var typedId = usernameInput.value.trim();
                var users = JSON.parse(localStorage.getItem('amsonsUsers') || '[]');
                var user = users.filter(function (u) { return u.id === 'AMS-' + typedId; })[0];
                adminName = user ? user.name : (typedId || 'ADMIN');
                adminNameEl.textContent = adminName;
            }

            // Assign this login the next free till number *within its
            // branch* (TILL # 1 for the first person open on a branch,
            // TILL # 2 for the next person open on that same branch at
            // the same time, and so on) instead of a hardcoded/random
            // number. See assignTillNumber() below.
            var tillNumEl = document.getElementById('tillNumLabel');
            if (tillNumEl) tillNumEl.textContent = 'TILL # ' + assignTillNumber(branchName);

            document.getElementById('branchScreen').style.display = 'none';
            document.getElementById('dashboardScreen').style.display = 'flex';
            if (typeof focusScanCapture === 'function') requestAnimationFrame(focusScanCapture);
            if (typeof loadQuickAccess === 'function') loadQuickAccess();

            // Kick off the till-open border light + welcome announcement
            // once the dashboard has actually laid out (so the topbar
            // has its real size to draw the light path around).
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    playTillOpenSequence(adminName, branchName);
                });
            });
        });
    });

    // ---- Dashboard sidebar: BACK (to branch selection) and LOGOUT ----
    // Both end the current till session (freeing its till number back
    // to the branch pool, same as closing the tab would via pagehide)
    // since leaving the dashboard either way means this till is no
    // longer open.
    document.getElementById('backToBranchBtn').addEventListener('click', function () {
        var s = getSessionTill();
        if (s) releaseTillNumber(s.branch, s.num);
        document.getElementById('dashboardScreen').style.display = 'none';
        document.getElementById('branchScreen').style.display = 'flex';
    });

    document.getElementById('dashLogoutBtn').addEventListener('click', function () {
        var s = getSessionTill();
        if (s) releaseTillNumber(s.branch, s.num);
        document.getElementById('dashboardScreen').style.display = 'none';
        document.getElementById('branchScreen').style.display = 'none';
        document.getElementById('loginScreen').style.display = 'flex';
        usernameInput.value = '';
        passwordInput.value = '';
    });

    /* ============================================================
       TILL-OPEN BORDER LIGHT + VOICE ANNOUNCEMENT
       Runs once, right after a branch is picked: a gold "current"
       chases around the topbar border from its top-right corner to
       its top-left corner, and once it lands, a spoken greeting
       announces the till is open ("Assalamu Alaikum, <name>. Till is
       open for <branch> branch now.").
       ============================================================ */
    function playTillOpenLight(topbarEl, onDone) {
        var svgNS = 'http://www.w3.org/2000/svg';
        var w = topbarEl.offsetWidth;
        var h = topbarEl.offsetHeight;

        var svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', w);
        svg.setAttribute('height', h);
        svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        svg.classList.add('till-open-light-svg');

        // Right corner -> down the right edge -> across the bottom ->
        // up the left edge -> left corner. Inset by half the stroke
        // width so the glow sits on the border itself, not outside it.
        var inset = 2;
        var path = document.createElementNS(svgNS, 'path');
        var d = 'M ' + (w - inset) + ' ' + inset +
                ' L ' + (w - inset) + ' ' + (h - inset) +
                ' L ' + inset + ' ' + (h - inset) +
                ' L ' + inset + ' ' + inset;
        path.setAttribute('d', d);
        path.setAttribute('stroke-width', '4');
        path.classList.add('till-open-light-path');
        svg.appendChild(path);
        topbarEl.appendChild(svg);

        var totalLen = path.getTotalLength();
        var dashLen = totalLen * 0.22;
        path.setAttribute('stroke-dasharray', dashLen + ' ' + totalLen);
        path.setAttribute('stroke-dashoffset', dashLen);

        var anim = path.animate(
            [
                { strokeDashoffset: dashLen, opacity: 0 },
                { strokeDashoffset: dashLen * 0.4, opacity: 1, offset: 0.08 },
                { strokeDashoffset: -(totalLen - dashLen * 0.6), opacity: 1, offset: 0.92 },
                { strokeDashoffset: -totalLen, opacity: 0 }
            ],
            { duration: 3000, easing: 'linear', fill: 'forwards' }
        );

        anim.onfinish = function () {
            svg.classList.add('fade-out');
            setTimeout(function () { svg.remove(); }, 400);
            if (onDone) onDone();
        };
    }

    function playTillOpenSequence(adminName, branchName) {
        // Runs around the full dashboard page (not just the black
        // header) so the light travels the whole screen's border.
        var screenEl = document.getElementById('dashboardScreen');
        if (!screenEl) return;
        playTillOpenLight(screenEl);
    }
