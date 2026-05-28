// ==UserScript==
// @name         Edmentum Solver - V1.1.0
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Automates Edmentum.
// @author       Floor
// @match        *://*.apps.elf.edmentum.com/*
// @match        *://app.edmentum.com/*
// @match        *://*.platoweb.com/*
// @icon         https://groq.com/favicon.ico
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.cerebras.ai
// @run-at       document-start
// @downloadURL https://update.greasyfork.org/scripts/578793/Edmentum%20Solver%20-%20V110.user.js
// @updateURL https://update.greasyfork.org/scripts/578793/Edmentum%20Solver%20-%20V110.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // Singleton Guard
    if (window.__ED_INITIALIZED) return;
    window.__ED_INITIALIZED = true;

    // ========================================================================
    // NAMESPACE, SELECTORS & STATE
    // ========================================================================
    const Ed = {
        Config: {},
        State: {
            answerRunning: false,
            tutorialRunning: false,
            tutorialBusy: false,
            answerBusy: false,
            isNavigating: false,
            answerIv: null,
            autoTos: [],
            lastQuestionSignature: null,
            lastAnswerRaw: null,
            lastAnswerWasWrong: false,
            questionRetryCount: 0,
            countdownInterval: null,
            currentCountdownId: 0,
            tutorialInitialDelayMet: false,
            manuallyPausedSubmission: false,
            hasConfirmedSubmission: false,
            notifiedAudioBlocked: false,
            activeProvider: 'cerebras',
            apiTimestamps: [],
            status: 'IDLE'
        },
        Utils: {},
        Recovery: {},
        Notifications: {},
        AI: {},
        Parsers: {},
        Answer: {},
        Tutorial: {},
        Nav: {},
        UI: {}
    };

    // ========================================================================
    // CONFIGURATION
    // ========================================================================
    Ed.Config = {
        CEREBRAS_MODEL: "zai-glm-4.7",
        API_ENDPOINTS: {
            CEREBRAS: "https://api.cerebras.ai/v1/chat/completions"
        },

        encode: (s) => btoa(unescape(encodeURIComponent(s))),
        decode: (s) => {
            try { return decodeURIComponent(escape(atob(s))); }
            catch(e) { return ''; }
        },

        get: (keyName, def) => {
            const val = GM_getValue(keyName);
            return val !== undefined ? val : def;
        },
        set: (keyName, val) => GM_setValue(keyName, val),

        safeGetKey: (keyName) => {
            let val = GM_getValue(keyName) || '';
            if (!val) return '';
            try { decodeURIComponent(escape(atob(val))); return Ed.Config.decode(val); }
            catch (e) { Ed.Config.set(keyName, Ed.Config.encode(val)); return val; }
        },

        parseRangeDelay: (keyName, defaultVal) => {
            let strVal = String(Ed.Config.get(keyName) || defaultVal).trim();
            if (strVal.includes('-')) {
                let parts = strVal.split('-');
                let min = parseInt(parts[0]);
                let max = parseInt(parts[1]);
                if (isNaN(min)) min = defaultVal;
                if (isNaN(max)) max = defaultVal;
                if (min > max) { let temp = min; min = max; max = temp; }
                return Math.floor(Math.random() * (max - min + 1)) + min;
            }
            let parsed = parseInt(strVal);
            return isNaN(parsed) ? defaultVal : parsed;
        },

        getAnswerDelay: () => Math.max(Ed.Config.parseRangeDelay("ANSWER_DELAY", 25), 1) * 1000,
        getTutorialDelay: () => Math.max(Ed.Config.parseRangeDelay("TUTORIAL_DELAY", 30), 1) * 1000
    };

    Ed.Utils = {
        delayAsync: (ms) => new Promise(r => setTimeout(r, ms)),
        log: {
            error: (...args) => console.error('[Ed Solver]', ...args),
            warn:  (...args) => console.warn('[Ed Solver]', ...args),
            info:  (...args) => console.info('[Ed Solver]', ...args)
        },
        setStatus: (newStatus) => {
            Ed.State.status = newStatus;
            Ed.UI.updateSolvingIndicator(newStatus === 'SOLVING' || newStatus === 'ADVANCING');
        },
        isLoginPage: () => {
            const hasPassword = document.querySelector('input[type="password"]');
            const hasLoginForm = document.querySelector('form[action*="login"], form[action*="signin"], form[action*="auth"], #login-form, .login-form');
            if (hasPassword && hasLoginForm) return true;
            if (/login|signin|auth/i.test(location.pathname + location.search)) return true;
            return false;
        },
        getDocs: () => {
            const d = [document];
            for (let i = 0; i < window.frames.length; i++) {
                try { d.push(window.frames[i].document); } catch(e) {}
            }
            return d;
        },
        $: (sel) => {
            for (const d of Ed.Utils.getDocs()) {
                const el = d.querySelector(sel);
                if (el) return { el, doc: d };
            }
            return null;
        },
        isVisible: (el, doc) => {
            if (!el) return false;
            const win = doc.defaultView || window;
            const style = win.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const margin = 2000;
            if (rect.bottom < -margin || rect.top > win.innerHeight + margin ||
                rect.right < -margin || rect.left > win.innerWidth + margin) {
                return false;
            }
            return true;
        },
        isClickable: (el, doc) => {
            if (!el) return false;
            if (el.disabled) return false;
            if (el.getAttribute('aria-disabled') === 'true') return false;
            if (el.classList.contains('disabled')) return false;
            const win = doc.defaultView || window;
            const style = win.getComputedStyle(el);
            if (style.pointerEvents === 'none') return false;
            return Ed.Utils.isVisible(el, doc);
        }
    };

    // ========================================================================
    // NOTIFICATIONS & MODALS
    // ========================================================================
    Ed.Notifications = {
        requestPermAndShowModal: () => {
            if ("Notification" in window) {
                if (Notification.permission !== "granted") {
                    Notification.requestPermission();
                    Ed.Notifications.showNotifAlertModal();
                }
            } else {
                Ed.UI.showToast("Notifications not supported in this browser.", 3000);
            }
        },

        showNotifAlertModal: () => {
            if (document.getElementById('ed-notif-modal')) return;
            Ed.UI.injectGlobalModalStyles();
            const overlay = document.createElement('div');
            overlay.id = 'ed-notif-modal';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.innerHTML = `
                <div class="modal-box" style="width: 400px; text-align: center;">
                    <div class="modal-title" style="justify-content: center;">🔔 Action Required</div>
                    <div class="modal-desc">
                        Please ensure notification permissions are <strong>enabled</strong> for this site in your browser settings!<br><br>
                        Look for a prompt near your URL bar, or click the site settings icon next to the URL.
                    </div>
                    <button class="save-btn" id="btn-close-notif">I understand</button>
                </div>`;
            document.body.appendChild(overlay);
            const btn = document.getElementById('btn-close-notif');
            btn.focus();
            btn.addEventListener('click', () => {
                overlay.style.animation = 'fadeOut 0.3s ease forwards';
                setTimeout(() => overlay.remove(), 300);
            });
        },

        send: (title, options) => {
            if (document.hasFocus() || document.visibilityState === 'visible') return;

            if (Ed.Config.get("AUTO_NOTIFY", true) && "Notification" in window && Notification.permission === "granted") {
                try { new Notification(title, options); } catch(e) {}
            }
        },

        showBackgroundModeInfo: () => {
            if (Ed.Config.get('HAS_SEEN_BG_MODAL', false)) return;
            Ed.Config.set('HAS_SEEN_BG_MODAL', true);
            Ed.UI.injectGlobalModalStyles();
            const overlay = document.createElement('div');
            overlay.id = 'ed-bg-alert-modal';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.innerHTML = `
                <div class="modal-box" style="width: 450px; text-align: center;">
                    <div class="modal-title" style="justify-content: center;">🔊 Audio Requirement</div>
                    <div class="modal-desc">
                        To keep the script running in the background, a silent audio loop is required.<br><br>
                        <strong style="color:#f8fafc;">1. Click anywhere</strong> on the page once to activate audio.<br>
                        <strong style="color:#f8fafc;">2. Check the Tab Icon:</strong><br>
                        If you see a <span style="font-size: 16px;">🔇</span> (Muted Speaker) in the tab title, audio is blocked by your browser settings.<br><br>
                        <em style="color:#94a3b8;">If muted: Click the lock icon in your URL bar and allow "Sound" to ensure background mode works.</em>
                    </div>
                    <button class="save-btn" id="btn-close-bg">I understand</button>
                </div>`;
            document.body.appendChild(overlay);
            const btn = document.getElementById('btn-close-bg');
            btn.focus();
            btn.addEventListener('click', () => {
                overlay.style.animation = 'fadeOut 0.3s ease forwards';
                setTimeout(() => overlay.remove(), 300);
            });
        },

        showSettingsAppliedModal: () => {
            if (document.getElementById('ed-applied-modal')) return;
            Ed.UI.injectGlobalModalStyles();
            const overlay = document.createElement('div');
            overlay.id = 'ed-applied-modal';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.innerHTML = `
                <div class="modal-box" style="width: 400px; text-align: center;">
                    <div class="modal-title" style="justify-content: center;">✅ All Set!</div>
                    <div class="modal-desc">
                        Settings have been applied successfully.<br><br>
                        <strong>Enjoy the automation!</strong>
                    </div>
                    <button class="save-btn" id="btn-close-applied">Let's Go</button>
                </div>`;
            document.body.appendChild(overlay);
            const btn = document.getElementById('btn-close-applied');
            btn.focus();
            btn.addEventListener('click', () => {
                overlay.style.animation = 'fadeOut 0.3s ease forwards';
                setTimeout(() => overlay.remove(), 300);
            });
        },

        showInvalidKeyModal: (provider, errorMsg) => {
            if (document.getElementById('ed-invalid-key-modal')) return;
            Ed.UI.injectGlobalModalStyles();
            const overlay = document.createElement('div');
            overlay.id = 'ed-invalid-key-modal';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.innerHTML = `
                <div class="modal-box" style="width: 420px; text-align: center;">
                    <div class="modal-title" style="justify-content: center; color: #ef4444;">❌ Invalid API Key</div>
                    <div class="modal-desc">
                        The <strong>${provider}</strong> API key you entered is <strong style="color:#ef4444;">invalid</strong>.<br><br>
                        Error: <code style="background:rgba(239,68,68,0.15); padding:4px 8px; border-radius:6px; font-size:12px;">${errorMsg}</code><br><br>
                        Please double-check your key and try again.
                    </div>
                    <button class="save-btn" style="background: #ef4444; box-shadow: 0 8px 25px rgba(239, 68, 68, 0.4);" id="btn-close-invalid-key">OK</button>
                </div>`;
            document.body.appendChild(overlay);
            const btn = document.getElementById('btn-close-invalid-key');
            btn.focus();
            btn.addEventListener('click', () => {
                overlay.style.animation = 'fadeOut 0.3s ease forwards';
                setTimeout(() => overlay.remove(), 300);
            });
        }
    };

    // ========================================================================
    // RECOVERY & BYPASSES
    // ========================================================================
    Ed.Recovery = {
        audioCtx: null,
        backgroundWorker: null,

        toggleAntiThrottle: (enable) => {
            try {
                if (enable) {
                    if (!Ed.Recovery.audioCtx) {
                        Ed.Recovery.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        const oscillator = Ed.Recovery.audioCtx.createOscillator();
                        const gainNode = Ed.Recovery.audioCtx.createGain();

                        oscillator.type = 'sine';
                        oscillator.frequency.value = 100;
                        gainNode.gain.value = 0.0005;

                        oscillator.connect(gainNode);
                        gainNode.connect(Ed.Recovery.audioCtx.destination);
                        oscillator.start();

                        const checkAudioStatus = () => {
                            if (Ed.Recovery.audioCtx && Ed.Recovery.audioCtx.state === 'suspended') {
                                Ed.Recovery.audioCtx.resume().catch(() => {});
                                setTimeout(() => {
                                    if (Ed.Recovery.audioCtx && Ed.Recovery.audioCtx.state === 'suspended' && !Ed.State.notifiedAudioBlocked) {
                                        alert("Edmentum Solver: Background Mode isn't working because Audio is blocked.\n\nPlease click the lock icon next to the URL, set 'Sound' to 'Allow', and refresh the page to keep the script running in the background.");
                                        Ed.State.notifiedAudioBlocked = true;
                                    }
                                }, 500);
                            }
                        };

                        if (Ed.Recovery.audioCtx.state === 'suspended') {
                            const resumeAudio = () => {
                                if(Ed.Recovery.audioCtx) Ed.Recovery.audioCtx.resume();
                                document.removeEventListener('click', resumeAudio);
                                checkAudioStatus();
                            };
                            document.addEventListener('click', resumeAudio);
                            setTimeout(checkAudioStatus, 4000);
                        }
                    }

                    if (!Ed.Recovery.backgroundWorker) {
                        const workerCode = `setInterval(() => postMessage('ping'), 200);`;
                        const blob = new Blob([workerCode], { type: 'application/javascript' });
                        Ed.Recovery.backgroundWorker = new Worker(URL.createObjectURL(blob));
                        Ed.Recovery.backgroundWorker.onmessage = () => { window.__ed_last_ping = Date.now(); };
                    }
                } else {
                    if (Ed.Recovery.audioCtx) {
                        Ed.Recovery.audioCtx.close();
                        Ed.Recovery.audioCtx = null;
                    }
                    if (Ed.Recovery.backgroundWorker) {
                        Ed.Recovery.backgroundWorker.terminate();
                        Ed.Recovery.backgroundWorker = null;
                    }
                }
            } catch(e) {}
        }
    };

    // ========================================================================
    // AI ENGINE
    // ========================================================================
    Ed.AI = {
       checkRateLimit: async (estimatedTokens = 6000) => {
            while (true) {
                const now = Date.now();
                if (!Ed.State.apiTimestamps) {
                    Ed.State.apiTimestamps = [];
                }
                // Filter out entries older than 60 seconds
                Ed.State.apiTimestamps = Ed.State.apiTimestamps.filter(item => now - item.timestamp < 60000);

                const currentRPM = Ed.State.apiTimestamps.length;
                const currentTPM = Ed.State.apiTimestamps.reduce((sum, item) => sum + item.tokens, 0);

                // Ensure both Requests Per Minute (5) and Tokens Per Minute (30,000) are clear
                if (currentRPM < 5 && (currentTPM + estimatedTokens) < 30000) {
                    break;
                }

                const oldest = Ed.State.apiTimestamps[0];
                const waitMs = oldest ? (oldest.timestamp + 60000) - now : 1000;

                if (waitMs > 0) {
                    const waitSecs = Math.ceil(waitMs / 1000);
                    const reason = currentRPM >= 5 ? "RPM limit (5 req/min)" : "TPM limit (30k tokens/min)";
                    Ed.UI.showToast(`Rate limit reached: ${reason}. Pausing for ${waitSecs}s to continue...`, 2000);
                    await Ed.Utils.delayAsync(1000); // Ticks countdown smoothly every second
                } else {
                    break;
                }
            }
        },

        validateKey: async (provider, key) => {
            await Ed.AI.checkRateLimit();
            return new Promise((resolve) => {
                const url = Ed.Config.API_ENDPOINTS.CEREBRAS;
                const model = Ed.Config.CEREBRAS_MODEL;

                GM_xmlhttpRequest({
                    method: "POST",
                    url: url,
                    headers: {
                        "Authorization": `Bearer ${key}`,
                        "Content-Type": "application/json"
                    },
                    data: JSON.stringify({
                        model: model,
                        messages:[{ role: "user", content: "test" }],
                        max_completion_tokens: 1,
                        reasoning_effort: "none"
                    }),
                    timeout: 15000,
                    onload: (response) => {
                        if (response.status === 401 || response.status === 403) {
                            let errMsg = "Invalid API Key";
                            try {
                                const json = JSON.parse(response.responseText);
                                errMsg = json.error?.message || json.message || errMsg;
                            } catch(e) {}
                            resolve({ valid: false, error: errMsg });
                        } else if (response.status === 429) {
                            resolve({ valid: true, error: null });
                        } else if (response.status >= 200 && response.status < 300) {
                            resolve({ valid: true, error: null });
                        } else {
                            let errMsg = `API returned status ${response.status}`;
                            try {
                                const json = JSON.parse(response.responseText);
                                errMsg = json.error?.message || json.message || errMsg;
                            } catch(e) {}
                            resolve({ valid: false, error: errMsg });
                        }
                    },
                    onerror: () => resolve({ valid: null, error: "Network error - check your connection" }),
                    ontimeout: () => resolve({ valid: null, error: "Request timed out" })
                });
            });
        },

        cleanAIResponse: (text) => {
            // 1. Extract the actual final answer appended after the model's native thinking phase
            if (text.includes('</think>')) {
                const parts = text.split('</think>');
                const last = parts[parts.length - 1].trim();
                text = last ? last : parts[0];
            } else if (text.includes('</thinking>')) {
                const parts = text.split('</thinking>');
                const last = parts[parts.length - 1].trim();
                text = last ? last : parts[0];
            } else if (text.includes('</reasoning>')) {
                const parts = text.split('</reasoning>');
                const last = parts[parts.length - 1].trim();
                text = last ? last : parts[0];
            }

            // 2. Target the strict final answer block next
            const finalAnswerMatch = text.match(/\[FINAL ANSWER\]([\s\S]*?)(?:\[\/FINAL ANSWER\]|$)/i);
            let extracted = finalAnswerMatch ? finalAnswerMatch[1] : text;

            // 3. Sanitize the output
            return extracted
                .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
                .replace(/<<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '')
                .replace(/<<reasoning[\s\S]*?<\/reasoning>/gi, '')
                .replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, '')
                .replace(/<\/?think(?:ing)?>/gi, '')
                .replace(/<\/?reasoning>/gi, '')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/^[\s\S]*?(?:answer[:\s]+|the answer is[:\s]+|correct answer[:\s]+|final answer[:\s]+)/i, '')
                .replace(/^[)\].>\s]+/, '')
                .replace(/[)\].>\s]+$/, '')
                .trim();
        },

        askAI: async (data) => {
            const keys = { cerebras: Ed.Config.safeGetKey('cerebras_key') };
            if (!Ed.State.answerRunning) throw new Error('STOPPED');

            if (!keys.cerebras) {
                Ed.UI.showToast(`Cerebras API key missing`, 3000);
                await Ed.Utils.delayAsync(3000);
                return;
            }

            while (true) {
                if (!Ed.State.answerRunning) throw new Error('STOPPED');

                const key = keys.cerebras;
                const model = Ed.Config.CEREBRAS_MODEL;
                const url = Ed.Config.API_ENDPOINTS.CEREBRAS;

               // Estimate prompt context length to check Tokens Per Minute limitations pre-request
                const promptContent = Ed.Parsers.buildPrompt(data);
                const estimatedTokens = Math.ceil(promptContent.length / 3) + 8192;

                try {
                    await Ed.AI.checkRateLimit(estimatedTokens);
                    if (!Ed.State.answerRunning) throw new Error('STOPPED');

                    Ed.UI.showToast(`Asking Cerebras GLM 4.7...`, 3000);

                    // Prints the prompt directly to your browser's Developer Console
                    Ed.Utils.log.info("Cerebras Outgoing Prompt:", promptContent);

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 60000);

                    const globalReasoningEnabled = Ed.Config.get("CEREBRAS_REASONING", true);
// Disable reasoning for this specific request if the AI was too chatty and kept getting truncated
const useReasoning = globalReasoningEnabled && !data._forceNoReasoning;

// Dynamic system prompt modifications if a truncation event was recorded
let systemContent = 'You are Z.ai GLM-4.7, an elite, highly logical expert tutor optimized for US grades 6-12 across all academic subjects (Mathematics, Science, English Language Arts, Social Studies, and History). Your goal is absolute 100% accuracy.';
if (useReasoning) {
systemContent += '\nSince reasoning is enabled, analyze the question deeply inside your thinking phase. Carefully parse all questions, diagrams, and options. Verify math calculations and context before formulating the final answer.';
} else {
systemContent += '\nReasoning is disabled for this attempt to prevent length cutoffs. Provide the most accurate answer directly. Carefully parse all questions, diagrams, and options.';
}
if (data._shortRetry) {
                        systemContent += '\n\nCRITICAL CONSTRAINTS: Your previous response ran too long and got cut off. You MUST be extremely concise on this attempt. Keep your [REASONING] block to under 2 sentences. Deliver your [FINAL ANSWER] as fast as possible to avoid truncation.';
                    }

                    systemContent += '\n\nYou must structure your final content output using EXACTLY this two-part format:\n\n[REASONING]\n(Provide a brief explanation of your logical deduction steps here to verify accuracy)\n[/REASONING]\n\n[FINAL ANSWER]\n(Provide ONLY the final answer as requested, with NO other text or formatting, matching the options exactly)\n- Single choice: output exactly one capital letter (e.g., B).\n- Multiple choice: output capital letters separated by commas (e.g., A,C).\n- Math/Numbers: output only the exact numbers/expressions separated by commas (e.g., 5,12.5,-3).\n- Drag/Drop: output the exact tile text separated by commas.\n[/FINAL ANSWER]';

                    const body = {
model: model,
messages: [
{ role: 'system', content: systemContent },
{ role: 'user', content: promptContent }
],
max_completion_tokens: 8192,
temperature: 0
};
if (!useReasoning) {
body.reasoning_effort = "none";
} else {
body.reasoning_format = "raw";
}
                    const res = await fetch(url, {
                        method: 'POST',
                        signal: controller.signal,
                        headers: {
                            'Authorization': `Bearer ${key}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(body)
                    });
                    clearTimeout(timeoutId);

                    const rawText = await res.text();
                    if (!Ed.State.answerRunning) throw new Error('STOPPED');

                    if (!res.ok) {
                        throw new Error(`${res.status}: ${rawText}`);
                    }

                    let json;
                    try { json = JSON.parse(rawText); } catch(e) { throw new Error('Invalid JSON: ' + rawText); }

                    if (json.error) {
                        throw new Error(json.error.message || JSON.stringify(json.error));
                    }
                    if (!json.choices || !json.choices.length) {
                        throw new Error('No choices array in response');
                    }

                   const choice0 = json.choices[0];

      if (choice0?.finish_reason === 'length') {
    // Track how many times we've attempted a shorter prompt
    data._shortRetryCount = (data._shortRetryCount || 0) + 1;

    if (data._shortRetryCount <= 2) {
        // Flag to trigger the concise restriction on the next loop retry
        data._shortRetry = true;
        throw new Error(`Response truncated (length). Retrying with shorter prompt (Attempt ${data._shortRetryCount}/2)...`);
    } else if (globalReasoningEnabled && !data._forceNoReasoning) {
        // If it still truncates after 2 short retries, disable reasoning for this specific question
        data._forceNoReasoning = true;
        data._shortRetryCount = 0; // Reset counter to allow 2 more attempts without reasoning
        data._shortRetry = true;
        Ed.UI.showToast(`AI too chatty. Disabling reasoning for this question...`, 3000);
        throw new Error('Response truncated. Disabling reasoning and retrying...');
    } else {
        // If it STILL truncates with reasoning disabled, force parse the partial response
        Ed.Utils.log.warn(`[AI Warning] Response truncated with reasoning disabled. Forcing parse of partial response...`);
        Ed.UI.showToast(`AI cut off again. Using partial answer...`, 3000);
        // Let the code fall through to parse the partial response instead of throwing an error
    }
}

                    let answer = choice0?.message?.content
                        || choice0?.text
                        || choice0?.content
                        || choice0?.message?.function_call?.arguments
                        || json.content
                        || json.response
                        || json.choices?.[0]?.delta?.content
                        || '';

                    const trimmed = Ed.AI.cleanAIResponse(answer || '');
                    if (!trimmed) {
                        throw new Error('Empty or invalid response content');
                    }

                    // Prints the cleaned answer directly to your browser's Developer Console
                    Ed.Utils.log.info("Cerebras Cleaned Response:", trimmed);

                    // Record real usage to prevent exceeding sliding TPM window
                    const actualTokens = json.usage?.total_tokens || estimatedTokens;
                    Ed.State.apiTimestamps.push({ timestamp: Date.now(), tokens: actualTokens });

                    return { answer: trimmed, provider: 'cerebras' };
                } catch (e) {
                    if (e.message === 'STOPPED') throw e;

                    // Capture high traffic / queue congestion rate limits
                    const isQueueExceeded = e.message.includes('queue_exceeded') ||
                                            e.message.includes('too_many_requests_error') ||
                                            e.message.includes('high traffic');

                    // Explicitly capture Cerebras token quota exceeded errors
                    const isTokenQuota = e.message.includes('token_quota_exceeded') ||
                                         e.message.includes('too_many_tokens_error') ||
                                         e.message.includes('Tokens per minute limit exceeded');

                    if (isQueueExceeded) {
                        Ed.Utils.log.warn(`[Cerebras Queue Limit] High traffic. Pausing 10s...`, e);

                        // 10 second ticking countdown for quick queue resets
                        for (let i = 10; i > 0; i--) {
                            if (!Ed.State.answerRunning) throw new Error('STOPPED');
                            Ed.UI.showToast(`Cerebras busy (high traffic). Waiting ${i}s...`, 1200);
                            await Ed.Utils.delayAsync(1000);
                        }
                    } else if (isTokenQuota) {
                        Ed.Utils.log.warn(`[Cerebras TPM Limit] Quota exceeded. Pausing 60s for window reset...`, e);

                        // Counts down smoothly and displays a ticking toast every second
                        for (let i = 60; i > 0; i--) {
                            if (!Ed.State.answerRunning) throw new Error('STOPPED');
                            Ed.UI.showToast(`TPM Limit Exceeded. Pausing for ${i}s...`, 1200);
                            await Ed.Utils.delayAsync(1000);
                        }
                    } else {
                        Ed.UI.showToast(`Cerebras error. Retrying...`, 3000);
                        Ed.Utils.log.error(`[AI Error]`, e);
                        await Ed.Utils.delayAsync(4000);
                    }
                }
            }
        },

        fetchAIAnswer: async (data, parseFn) => {
            let result;
            try {
                result = await Ed.AI.askAI(data);
            } catch (e) {
                throw e;
            }

            let parsed = parseFn(result.answer);
            const isEmpty = !parsed || (Array.isArray(parsed) && parsed.length === 0) || (typeof parsed === 'object' && Object.keys(parsed).length === 0 && !(parsed instanceof HTMLElement));
            if (isEmpty) {
                Ed.UI.showToast('Answer unparseable, retrying with stricter prompt...', 3000);
                data._strictRetry = true;
                await Ed.Utils.delayAsync(1500);
                try {
                    result = await Ed.AI.askAI(data);
                } catch (e) {
                    data._strictRetry = false;
                    throw e;
                }
                parsed = parseFn(result.answer);
                data._strictRetry = false;
            }
            return { result, parsed };
        }
    };

    // ========================================================================
    // PARSERS & EXTRACTORS
    // ========================================================================
    Ed.Parsers = {
        cleanText: (str) => {
            return (str || '').replace(/\s+/g, ' ').trim();
        },

        getTopicContext: (doc) => {
            let topic = '';

            // 1. Check practice topbar thspan sentence
            const thspan = doc.querySelector('thspan.thsentence, .thsentence');
            if (thspan) {
                const t = thspan.textContent.trim().replace(/:$/, '');
                if (t && t.length > 2 && t.length < 100) topic = t;
            }

            // 2. Check quiz/mastery test title h1
            if (!topic) {
                const testTitle = doc.querySelector('#test-title, .test-title, h1[id="test-title"]');
                if (testTitle) {
                    const t = testTitle.textContent.trim().replace(/:\s*Mastery\s*Test/i, '').replace(/:$/, '');
                    if (t && t.length > 2 && t.length < 100) topic = t;
                }
            }

            // 3. Fallback to generic module header title
            if (!topic) {
                const header = doc.querySelector('.header-title, .module-title');
                if (header) {
                    const t = header.textContent.trim().replace(/:$/, '');
                    if (t && t.length > 2 && t.length < 100) topic = t;
                }
            }

            return topic;
        },

        normalizeMathText: (text) => {
            return text
                .replace(/upper\s+([A-Z])/gi, '$1')
                .replace(/lower\s+([a-z])/gi, '$1')
                .replace(/StartRoot\s+([^]+?)\s+EndRoot/gi, '√$1')
                .replace(/EndRoot/gi, '')
                .replace(/StartFraction\s+([^]+?)\s+Over\s+([^]+?)\s+EndFraction/gi, '($1)/($2)')
                .replace(/StartBounds\s+([^]+?)\s+EndBounds/gi, '[$1]')
                .replace(/sqrt/gi, '√')
                .replace(/pi/gi, 'π')
                .replace(/times/gi, '*')
                .replace(/divided\s+by/gi, '/')
                .replace(/\s+/g, ' ')
                .trim();
        },

        getVisibleText: (el) => {
            if (!el) return '';
            const clone = el.cloneNode(true);
            clone.querySelectorAll('.sr-only, [hidden], [aria-hidden="true"], script, style').forEach(e => e.remove());
            let text = clone.innerText;
            if (!text || text.trim() === '') text = clone.textContent;
            return Ed.Parsers.cleanText(text);
        },

        getChoiceText: (el) => {
            const readable = el.querySelector('.mathjax-readable');
            if (readable) {
                const text = Ed.Parsers.cleanText(readable.textContent);
                if (text) return Ed.Parsers.normalizeMathText(text);
            }
            const mjx = el.querySelector('mjx-container');
            if (mjx) {
                const aria = mjx.getAttribute('aria-label');
                if (aria) return Ed.Parsers.normalizeMathText(aria);
            }
            const content = el.querySelector('[data-ed-element="content"]');
            if (content) {
                const text = Ed.Parsers.getVisibleText(content);
                if (text) return Ed.Parsers.normalizeMathText(text);
            }
            return Ed.Parsers.normalizeMathText(Ed.Parsers.getVisibleText(el));
        },

        findQuestionContainer: (widget, doc) => {
            let el = widget;
            while (el && el !== doc.body) {
                if (el.querySelector('.prompt') && el.querySelector('.stem')) return el;
                el = el.parentElement;
            }
            return doc.body;
        },

        extractQuestionText: (widget, doc) => {
            const container = Ed.Parsers.findQuestionContainer(widget, doc);
            // Fallback to standard classes if .content-wrapper is missing
            const promptEl = container.querySelector('.prompt .content-wrapper') || container.querySelector('.prompt');
            const stemEl = container.querySelector('.stem .content-wrapper') || container.querySelector('.stem');

            const prompt = Ed.Parsers.getVisibleText(promptEl);
            const stem = Ed.Parsers.getVisibleText(stemEl);

            // Retrieve topic or module context to prime the AI
            const topic = Ed.Parsers.getTopicContext(doc);

            // Search the entire document for reading passages or poems
            let passage = '';
            const passageEl = doc.querySelector('.passage, .reading-passage, [class*="passage"]');
            if (passageEl) {
                passage = Ed.Parsers.getVisibleText(passageEl);
            }

            let fullText = '';
            if (topic) {
                fullText += `=== SUBJECT/TOPIC CONTEXT: ${topic} ===\n\n`;
            }
            if (passage && passage.length > 5) {
                fullText += '=== READING PASSAGE / CONTEXT ===\n' + passage + '\n=================================\n\n';
            }
            fullText += (prompt ? prompt + '\n' : '') + (stem || '');

            return Ed.Parsers.normalizeMathText(fullText);
        },

        getImageInfo: (widget, doc) => {
            const images = [];
            const container = Ed.Parsers.findQuestionContainer(widget, doc);

            function getFilenameHint(url) {
                if (!url) return '';
                try {
                    const pathname = new URL(url, location.href).pathname;
                    const filename = pathname.split('/').pop().split('.')[0];
                    if (filename && filename.length > 2 && filename.length < 200) {
                        return filename.replace(/[_-]+/g, ' ').replace(/\+/g, ' ');
                    }
                } catch (e) {}
                return '';
            }

            function getImageContext(el) {
                const figure = el.closest('figure, .figure, .image-container, .media-container, .diagram-container, .question-image');
                if (figure) {
                    const caption = figure.querySelector('figcaption, .caption, .image-caption, .media-caption, .label');
                    if (caption) {
                        const t = Ed.Parsers.cleanText(caption.textContent);
                        if (t.length > 0 && t.length < 500) return t;
                    }
                }
                let prev = el.previousElementSibling;
                if (prev) {
                    const t = Ed.Parsers.cleanText(prev.textContent);
                    if (t.length > 3 && t.length < 300) return t;
                }
                const parent = el.parentElement;
                if (parent && parent !== container) {
                    const parentClone = parent.cloneNode(true);
                    const selfInClone = parentClone.querySelector(el.tagName.toLowerCase());
                    if (selfInClone) selfInClone.remove();
                    const t = Ed.Parsers.cleanText(parentClone.textContent);
                    if (t.length > 3 && t.length < 300) return t;
                }
                let next = el.nextElementSibling;
                if (next) {
                    const t = Ed.Parsers.cleanText(next.textContent);
                    if (t.length > 3 && t.length < 300) return t;
                }
                return '';
            }

            function addImageRecord(el, type, srcOverride) {
                const src = srcOverride || el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
                const alt = el.alt || el.getAttribute('alt') || '';
                const aria = el.getAttribute('aria-label') || '';
                const title = el.getAttribute('title') || '';
                const context = getImageContext(el);
                const filenameHint = getFilenameHint(src);
                const rect = el.getBoundingClientRect();

                images.push({
                    type,
                    src,
                    alt,
                    aria,
                    title,
                    context,
                    filenameHint,
                    className: el.className || '',
                    width: Math.round(rect.width) || el.naturalWidth || el.offsetWidth || 0,
                    height: Math.round(rect.height) || el.naturalHeight || el.offsetHeight || 0
                });
            }

            container.querySelectorAll('img').forEach(img => {
                const w = img.naturalWidth || img.offsetWidth || 0;
                const h = img.naturalHeight || img.offsetHeight || 0;
                if (w > 0 && w < 5 && h > 0 && h < 5) return;
                addImageRecord(img, 'img');
            });

            container.querySelectorAll('[style*="background-image"]').forEach(el => {
                const style = el.getAttribute('style') || '';
                const bg = style.match(/url\(["']?([^"')]+)["']?\)/);
                if (bg && bg[1]) addImageRecord(el, 'bg', bg[1]);
            });

            container.querySelectorAll('svg').forEach(svg => {
                const aria = svg.getAttribute('aria-label') || '';
                const svgText = Array.from(svg.querySelectorAll('text, tspan')).map(t => t.textContent).join(' ');
                const context = Ed.Parsers.cleanText(svgText).substring(0, 500);
                const rect = svg.getBoundingClientRect();
                images.push({
                    type: 'svg',
                    src: '',
                    alt: '',
                    aria,
                    title: svg.getAttribute('title') || '',
                    context,
                    filenameHint: '',
                    className: svg.className || '',
                    width: Math.round(rect.width) || svg.clientWidth || 0,
                    height: Math.round(rect.height) || svg.clientHeight || 0
                });
            });

            container.querySelectorAll('canvas').forEach(canvas => {
                const rect = canvas.getBoundingClientRect();
                images.push({
                    type: 'canvas',
                    src: '',
                    alt: canvas.getAttribute('aria-label') || '',
                    aria: canvas.getAttribute('aria-label') || '',
                    title: canvas.getAttribute('title') || '',
                    context: getImageContext(canvas),
                    filenameHint: '',
                    className: canvas.className || '',
                    width: Math.round(rect.width) || canvas.width || 0,
                    height: Math.round(rect.height) || canvas.height || 0
                });
            });

            container.querySelectorAll('[aria-label]').forEach(el => {
                const label = el.getAttribute('aria-label') || '';
                if (label.length > 5 && label.length < 500 && !images.some(i => i.aria === label)) {
                    images.push({
                        type: 'desc',
                        src: '',
                        alt: '',
                        aria: label,
                        title: el.getAttribute('title') || '',
                        context: getImageContext(el),
                        filenameHint: '',
                        className: el.className || '',
                        width: el.offsetWidth || 0,
                        height: el.offsetHeight || 0
                    });
                }
            });

            container.querySelectorAll('.diagram, .figure, .chart, .graph, .image, .question-image, .media').forEach(el => {
                if (el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'CANVAS') return;
                const style = el.getAttribute('style') || '';
                const bg = style.match(/url\(["']?([^"')]+)["']?\)/);
                if (bg && bg[1] && !images.some(i => i.src === bg[1])) {
                    addImageRecord(el, 'bg', bg[1]);
                }
            });

            const seen = new Set();
            return images.filter(img => {
                const key = (img.src || '') + '|' + (img.aria || '') + '|' + (img.context || '').substring(0, 100);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        },

        formatImageInfo: (images) => {
            if (!images || images.length === 0) return '';
            let out = '\n\n=== VISUAL / DIAGRAM CONTEXT ===\n';
            out += 'There are ' + images.length + ' visual element(s) in this question. You cannot see the image directly, but use EVERY clue below combined with the question text and answer choices to reconstruct the visual information as accurately as possible.\n\n';

            images.forEach((img, i) => {
                const parts = [];

                if (img.type === 'svg') parts.push('[SVG Diagram]');
                else if (img.type === 'canvas') parts.push('[Canvas/Drawing]');
                else if (img.type === 'bg') parts.push('[Background Image]');
                else if (img.type === 'desc') parts.push('[Described Element]');
                else parts.push('[Image]');

                if (img.width > 0 && img.height > 0) {
                    parts.push('Size: ' + img.width + 'x' + img.height + 'px');
                }

                if (img.alt) parts.push('Alt text: "' + img.alt + '"');
                if (img.aria) parts.push('ARIA label: "' + img.aria + '"');
                if (img.title) parts.push('Title: "' + img.title + '"');
                if (img.context) parts.push('Context: "' + img.context + '"');
                if (img.filenameHint) parts.push('Filename hint: "' + img.filenameHint + '"');
                if (img.src) parts.push('URL: ' + img.src);
                if (img.className) parts.push('CSS classes: ' + img.className);

                if (!img.alt && !img.aria && !img.title && !img.context && !img.filenameHint && !img.src) {
                    parts.push('No textual clues available. Use the question text and standard mathematical/geometric principles to infer the diagram content.');
                }

                out += (i + 1) + '. ' + parts.join(' | ') + '\n';
            });

            out += '\n=== INSTRUCTIONS FOR IMAGE INTERPRETATION ===\n';
            out += 'Even though you cannot see the image directly, treat the clues above as if you are analyzing the diagram:\n';
            out += '- If the filename or alt text mentions shapes (triangle, circle, graph, etc.), assume standard properties.\n';
            out += '- If dimensions like "30x40" or "400x300" are given, the diagram may be a coordinate plane, graph, or scaled figure.\n';
            out += '- If SVG text content includes letters like A, B, C or numbers, those are likely vertex labels, lengths, or angle measures.\n';
            out += '- Use standard geometric principles: Pythagorean theorem, special right triangles (30-60-90, 45-45-90), similar triangles, circle theorems, trigonometric ratios, etc.\n';
            out += '- If the question mentions a diagram but no description is given, the visual is likely essential to solving the problem. Do not ignore it.\n';
            out += '=== END VISUAL CONTEXT ===\n';

            return out;
        },

        getQuestionSignature: (data) => {
            if (!data) return '';
            const base = (data.question || '').trim();
            if (data.type === 'mcq') {
                return 'mcq:' + base + '|' + data.choices.map(c => (c.text || '').trim()).join('|');
            }
            if (data.type === 'multiresponse') {
                return 'mr:' + base + '|' + data.choices.map(c => (c.text || '').trim()).join('|');
            }
            if (data.type === 'hottext') {
                return 'hottext:' + base + '|' + data.choices.map(c => (c.text || '').trim()).join('|');
            }
            if (data.type === 'ggm') {
                return 'ggm:' + base + '|' +
                    data.draggables.map(d => (d.text || '').trim()).join('|') + '|' +
                    data.droppables.map(z => (z.label || '').trim()).join('|');
            }
            if (data.type === 'mpsimple') {
                return 'mpsimple:' + base + '|' +
                    data.draggables.map(d => (d.text || '').trim()).join('|') + '|' +
                    data.droppables.map(z => (z.label || '').trim()).join('|');
            }
            if (data.type === 'matchedpairs') {
                return 'mp:' + base + '|' +
                    data.leftItems.map(i => (i.text || '').trim()).join('|') + '|' +
                    data.draggables.map(t => (t.text || '').trim()).join('|');
            }
            if (data.type === 'textentry') {
                return 'te:' + base + '|' + data.inputs.length + '|' + data.template;
            }
            if (data.type === 'seqresponse') {
                return 'seq:' + base + '|' +
                    data.draggables.map(d => (d.text || '').trim()).join('|') + '|' +
                    data.droppables.map(z => (z.label || '').trim()).join('|');
            }
            if (data.type === 'inlinechoice') {
                return 'ic:' + base + '|' + data.template + '|' + data.menus.map(m => m.options.map(o => (o.text || '').trim()).join('|')).join('||');
            }
            if (data.type === 'hotspot') {
                return 'hotspot:' + base + '|' + data.hotspots.map(h => (h.label || '').trim()).join('|');
            }
            return '';
        },

        extractMCQ: () => {
            for (const d of Ed.Utils.getDocs()) {
                const mcqs = d.querySelectorAll('.multichoice');
                for (const mcq of mcqs) {
                    if (!Ed.Utils.isVisible(mcq, d)) continue;
                    const question = Ed.Parsers.extractQuestionText(mcq, d);
                    const choices = Array.from(mcq.querySelectorAll('.multichoice-choice')).map((c, idx) => {
                        let letter = c.querySelector('.multichoice-answer-letter')?.innerText?.trim() || '';
                        // Guard: Generate letter fallback dynamically if DOM node text is missing
                        if (!letter) {
                            letter = String.fromCharCode(65 + idx);
                        }
                        const text = Ed.Parsers.getChoiceText(c.querySelector('.content-inner') || c);
                        const id = c.dataset.identifier;
                        return { letter, text, id };
                    });
                    if (choices.length > 0) {
                        const images = Ed.Parsers.getImageInfo(mcq, d);
                        return { question, choices, doc: d, widget: mcq, type: 'mcq', images };
                    }
                }
            }
            return null;
        },

        extractMultipleResponse: () => {
            for (const d of Ed.Utils.getDocs()) {
                const mrs = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/MultipleResponse"]');
                for (const mr of mrs) {
                    if (!Ed.Utils.isVisible(mr, d)) continue;
                    const question = Ed.Parsers.extractQuestionText(mr, d);
                    const choiceEls = Array.from(mr.querySelectorAll('.multiresponse-choice'));
                    const choices = choiceEls.map((c, idx) => {
                        const input = c.querySelector('input[type="checkbox"]');
                        const letter = String.fromCharCode(65 + idx);
                        const text = Ed.Parsers.getChoiceText(c);
                        const id = input?.dataset?.identifier || c.dataset?.identifier;
                        return { letter, text, id, checked: input?.checked || false };
                    });
                    if (choices.length > 0) {
                        const images = Ed.Parsers.getImageInfo(mr, d);
                        return { question, choices, doc: d, widget: mr, type: 'multiresponse', images };
                    }
                }
            }
            return null;
        },

        extractHottext: () => {
            for (const d of Ed.Utils.getDocs()) {
                const widgets = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/HottextMultiChoice"], .interactive-template[data-ed-tmpl="/widgets/HottextMultiResponse"]');
                for (const widget of widgets) {
                    if (!Ed.Utils.isVisible(widget, d)) continue;
                    const question = Ed.Parsers.extractQuestionText(widget, d);
                    const isMulti = widget.dataset.edTmpl.includes('MultiResponse');

                    const choices = Array.from(widget.querySelectorAll('.hottext-mc-span, .hottext-mr-span')).map((c, idx) => {
                        let extraContext = '';
                        const tr = c.closest('tr');
                        if (tr) {
                            const rowText = Ed.Parsers.getVisibleText(tr);
                            extraContext = ` (Statement: ${rowText.replace(/(True|False)/ig, '').trim()})`;
                        }
                        return {
                            id: c.getAttribute('name') || c.id || idx.toString(),
                            text: Ed.Parsers.getChoiceText(c) + extraContext,
                            letter: String.fromCharCode(65 + idx),
                            el: c,
                            pressed: c.getAttribute('aria-pressed') === 'true'
                        };
                    }).filter(c => c.text);

                    if (choices.length > 0) {
                        const images = Ed.Parsers.getImageInfo(widget, d);
                        return { question, choices, doc: d, widget, type: 'hottext', isMulti, images };
                    }
                }
            }
            return null;
        },

        extractGGM: () => {
            for (const d of Ed.Utils.getDocs()) {
                const ggms = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/GraphicGapMatch"]');
                for (const ggm of ggms) {
                    if (!Ed.Utils.isVisible(ggm, d)) continue;
                    const container = Ed.Parsers.findQuestionContainer(ggm, d);
                    const promptEl = container.querySelector('.prompt');
                    const stemEl = container.querySelector('.stem');
                    if (!Ed.Utils.isVisible(promptEl, d) && !Ed.Utils.isVisible(stemEl, d)) continue;

                    const question = Ed.Parsers.extractQuestionText(ggm, d);
                    const draggables = Array.from(ggm.querySelectorAll('.draggable-item')).map((el, idx) => {
                        let text = Ed.Parsers.getChoiceText(el);
                        if (!text) {
                            const img = el.querySelector('img');
                            if (img) {
                                const alt = img.getAttribute('alt');
                                const src = img.getAttribute('src') || '';
                                const file = src.split('/').pop().split('?')[0];
                                text = alt ? `[Image: ${alt}]` : `[Image: ${file}]`;
                            } else {
                                text = `[Tile ${idx + 1}]`;
                            }
                        }
                        return {
                            id: el.dataset.identifier,
                            text: text
                        };
                    }).filter(d => d.text && d.id);

                    const droppables = Array.from(ggm.querySelectorAll('.droppable.target')).map((el, idx) => {
                        const top = parseInt(el.style.top) || 0;
                        const left = parseInt(el.style.left) || 0;
                        const parts = [];
                        if (top < 100) parts.push('upper area');
                        else parts.push('lower area');
                        if (left < 100) parts.push('left side');
                        else if (left > 120) parts.push('right side');
                        else parts.push('center');
                        return {
                            id: el.dataset.identifier,
                            label: el.getAttribute('aria-label') || '',
                            positionDesc: parts.join(', ')
                        };
                    });

                    if (draggables.length && droppables.length) {
                        const images = Ed.Parsers.getImageInfo(ggm, d);
                        return { question, draggables, droppables, doc: d, widget: ggm, type: 'ggm', images };
                    }
                }
            }
            return null;
        },

        extractMatchedPairsSimple: () => {
            for (const d of Ed.Utils.getDocs()) {
                const widgets = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/MatchedPairsSimple"]');
                for (const widget of widgets) {
                    if (!Ed.Utils.isVisible(widget, d)) continue;
                    const question = Ed.Parsers.extractQuestionText(widget, d);

                    const droppables = Array.from(widget.querySelectorAll('.droppable.ui-droppable')).map((el, idx) => {
                        const rowWrapper = el.closest('.droppable-wrapper');
                        const rowPos = rowWrapper ? rowWrapper.dataset.position : `r${Math.floor(idx/2)}`;
                        const isLeft = el.previousElementSibling === null;
                        return {
                            id: el.dataset.droppableid || el.dataset.safedroppableid || el.getAttribute('data-droppableid'),
                            label: `Row ${rowPos}, ${isLeft ? 'Left Box' : 'Right Box'}`,
                            el: el
                        };
                    });

                    const draggables = Array.from(widget.querySelectorAll('.draggable-item')).map((el, idx) => {
                        let text = Ed.Parsers.getChoiceText(el);
                        if (!text) {
                            const img = el.querySelector('img');
                            if (img) {
                                const alt = img.getAttribute('alt');
                                const src = img.getAttribute('src') || '';
                                const file = src.split('/').pop().split('?')[0];
                                text = alt ? `[Image: ${alt}]` : `[Image: ${file}]`;
                            } else {
                                text = `[Tile ${idx + 1}]`;
                            }
                        }
                        return {
                            id: el.dataset.identifier,
                            text: text,
                            dropped: el.dataset.dropped === 'true',
                            el: el
                        };
                    }).filter(t => t.text && t.id);

                    if (draggables.length > 0 && droppables.length > 0) {
                        const images = Ed.Parsers.getImageInfo(widget, d);
                        return { question, draggables, droppables, doc: d, widget, type: 'mpsimple', images };
                    }
                }
            }
            return null;
        },

        extractMatchedPairs: () => {
            for (const d of Ed.Utils.getDocs()) {
                const mps = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/MatchedPairsDirected"]');
                for (const mp of mps) {
                    if (!Ed.Utils.isVisible(mp, d)) continue;
                    const container = Ed.Parsers.findQuestionContainer(mp, d);
                    const promptEl = container.querySelector('.prompt');
                    const stemEl = container.querySelector('.stem');
                    if (!Ed.Utils.isVisible(promptEl, d) && !Ed.Utils.isVisible(stemEl, d)) continue;

                    const question = Ed.Parsers.extractQuestionText(mp, d);
                    const leftItems = Array.from(mp.querySelectorAll('.match.answer-display')).map(el => ({
                        id: el.dataset.identifier,
                        text: Ed.Parsers.getChoiceText(el),
                        position: el.dataset.position
                    })).filter(i => i.text && i.id);

                    const dropZones = Array.from(mp.querySelectorAll('.droppable.ui-droppable')).map(el => ({
                        id: el.dataset.droppableid || el.dataset.safedroppableid,
                        position: el.dataset.position
                    }));

                    const draggables = Array.from(mp.querySelectorAll('.draggable-item')).map((el, idx) => {
                        let text = Ed.Parsers.getChoiceText(el);
                        if (!text) {
                            const img = el.querySelector('img');
                            if (img) {
                                const alt = img.getAttribute('alt');
                                const src = img.getAttribute('src') || '';
                                const file = src.split('/').pop().split('?')[0];
                                text = alt ? `[Image: ${alt}]` : `[Image: ${file}]`;
                            } else {
                                text = `[Tile ${idx + 1}]`;
                            }
                        }
                        return {
                            id: el.dataset.identifier,
                            text: text,
                            dropped: el.dataset.dropped === 'true'
                        };
                    }).filter(t => t.text && t.id);

                    if (leftItems.length && draggables.length) {
                        const images = Ed.Parsers.getImageInfo(mp, d);
                        return { question, leftItems, dropZones, draggables, doc: d, widget: mp, type: 'matchedpairs', images };
                    }
                }
            }
            return null;
        },

        extractTextEntry: () => {
            for (const d of Ed.Utils.getDocs()) {
                const widgets = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/TextEntry"]');
                for (const widget of widgets) {
                    if (!Ed.Utils.isVisible(widget, d)) continue;
                    const container = Ed.Parsers.findQuestionContainer(widget, d);
                    const promptEl = container.querySelector('.prompt');
                    const stemEl = container.querySelector('.stem');
                    if (!Ed.Utils.isVisible(promptEl, d) && !Ed.Utils.isVisible(stemEl, d)) continue;

                    const question = Ed.Parsers.extractQuestionText(widget, d);
                    const entryContent = widget.querySelector('.text-entry-content');
                    if (!entryContent) continue;

                    let template = '';
                    const inputs = [];

                    function walk(node) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            template += node.textContent;
                        } else if (node.nodeType === Node.ELEMENT_NODE) {
                            const tag = node.tagName.toLowerCase();
                            if (tag === 'script' || tag === 'style' || tag === 'label') return;
                            if (tag === 'span' && (node.getAttribute('style') || '').includes('width:0')) return;
                            if (node.classList && node.classList.contains('mathjax-readable')) return;

                            if (tag === 'input' && node.classList.contains('textentry-input')) {
                                const idx = inputs.length + 1;
                                inputs.push({ id: node.id, name: node.name, index: idx, el: node });
                                template += ` {${idx}} `;
                            } else if (tag === 'mjx-container') {
                                const aria = node.getAttribute('aria-label') || '';
                                template += aria;
                            } else {
                                Array.from(node.childNodes).forEach(walk);
                            }
                        }
                    }

                    Array.from(entryContent.childNodes).forEach(walk);
                    template = Ed.Parsers.normalizeMathText(template.replace(/\s+/g, ' ').trim());

                    if (inputs.length > 0) {
                        const images = Ed.Parsers.getImageInfo(widget, d);
                        return { question, template, inputs, doc: d, widget, type: 'textentry', images };
                    }
                }
            }
            return null;
        },

        extractSeqResponse: () => {
            for (const d of Ed.Utils.getDocs()) {
                const seqs = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/SeqResponse"]');
                for (const seq of seqs) {
                    if (!Ed.Utils.isVisible(seq, d)) continue;
                    const container = Ed.Parsers.findQuestionContainer(seq, d);
                    const promptEl = container.querySelector('.prompt');
                    const stemEl = container.querySelector('.stem');
                    if (!Ed.Utils.isVisible(promptEl, d) && !Ed.Utils.isVisible(stemEl, d)) continue;

                    const question = Ed.Parsers.extractQuestionText(seq, d);

                    const droppables = Array.from(seq.querySelectorAll('.droppable-wrapper .droppable')).map((el, idx) => ({
                        id: el.dataset.position || idx.toString(),
                        position: parseInt(el.dataset.position) || idx,
                        label: el.getAttribute('aria-label') || `Drop zone ${idx + 1}`,
                        el: el
                    }));

                    const draggables = Array.from(seq.querySelectorAll('.draggable-item')).map((el, idx) => {
                        let text = Ed.Parsers.getChoiceText(el);
                        if (!text) {
                            const img = el.querySelector('img');
                            if (img) {
                                const alt = img.getAttribute('alt');
                                const src = img.getAttribute('src') || '';
                                const file = src.split('/').pop().split('?')[0];
                                text = alt ? `[Image: ${alt}]` : `[Image: ${file}]`;
                            }
                        }

                        const mathEl = el.querySelector('mjx-container');
                        const mathAria = mathEl ? mathEl.getAttribute('aria-label') : '';
                        const readableMath = el.querySelector('.mathjax-readable readablechild');
                        const mathText = readableMath ? Ed.Parsers.cleanText(readableMath.textContent) : '';

                        return {
                            id: el.dataset.identifier,
                            letter: String.fromCharCode(65 + idx),
                            text: text,
                            mathText: mathText || mathAria,
                            dropped: el.dataset.dropped === 'true',
                            el: el
                        };
                    }).filter(t => t.text && t.id);

                    if (draggables.length > 0 && droppables.length > 0) {
                        const images = Ed.Parsers.getImageInfo(seq, d);
                        return {
                            question,
                            draggables,
                            droppables,
                            doc: d,
                            widget: seq,
                            type: 'seqresponse',
                            images
                        };
                    }
                }
            }
            return null;
        },

        extractInlineChoice: () => {
            for (const d of Ed.Utils.getDocs()) {
                const widgets = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/InlineChoice"]');
                for (const widget of widgets) {
                    if (!Ed.Utils.isVisible(widget, d)) continue;
                    const container = Ed.Parsers.findQuestionContainer(widget, d);
                    const promptEl = container.querySelector('.prompt');
                    const stemEl = container.querySelector('.stem');
                    if (!Ed.Utils.isVisible(promptEl, d) && !Ed.Utils.isVisible(stemEl, d)) continue;

                    const question = Ed.Parsers.extractQuestionText(widget, d);
                    const contentBlock = widget.querySelector('.inline-choice-content');
                    if (!contentBlock) continue;

                    const selects = Array.from(contentBlock.querySelectorAll('select.inlinechoice-select'));
                    if (selects.length === 0) continue;

                    const menus = selects.map((select, idx) => {
                        const options = Array.from(select.querySelectorAll('option')).filter(opt => opt.value !== '').map((opt, optIdx) => ({
                            letter: String.fromCharCode(65 + optIdx),
                            value: opt.value,
                            text: Ed.Parsers.cleanText(opt.textContent)
                        }));
                        return {
                            index: idx + 1,
                            id: select.id,
                            name: select.name,
                            ariaLabel: select.getAttribute('aria-label') || '',
                            options,
                            el: select
                        };
                    });

                    const paragraph = contentBlock.querySelector('p');
                    let template = '';
                    let menuIdx = 0;

                    function walkInline(node) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            template += node.textContent;
                        } else if (node.nodeType === Node.ELEMENT_NODE) {
                            const tag = node.tagName.toLowerCase();
                            if (tag === 'script' || tag === 'style') return;
                            if (tag === 'select' && node.classList.contains('inlinechoice-select')) {
                                menuIdx++;
                                template += ` {${menuIdx}} `;
                            } else if (tag === 'mjx-container') {
                                const aria = node.getAttribute('aria-label') || '';
                                template += aria;
                            } else {
                                Array.from(node.childNodes).forEach(walkInline);
                            }
                        }
                    }

                    if (paragraph) {
                        Array.from(paragraph.childNodes).forEach(walkInline);
                    }
                    template = Ed.Parsers.normalizeMathText(template.replace(/\s+/g, ' ').trim());

                    const images = Ed.Parsers.getImageInfo(widget, d);
                    return { question, template, menus, doc: d, widget, type: 'inlinechoice', images };
                }
            }
            return null;
        },

        extractHotspot: () => {
            for (const d of Ed.Utils.getDocs()) {
                const widgets = d.querySelectorAll('.interactive-template[data-ed-tmpl="/widgets/Hotspot"]');
                for (const widget of widgets) {
                    if (!Ed.Utils.isVisible(widget, d)) continue;
                    const container = Ed.Parsers.findQuestionContainer(widget, d);
                    const promptEl = container.querySelector('.prompt');
                    const stemEl = container.querySelector('.stem');
                    if (!Ed.Utils.isVisible(promptEl, d) && !Ed.Utils.isVisible(stemEl, d)) continue;

                    const question = Ed.Parsers.extractQuestionText(widget, d);

                    const hotspots = [];
                    const wrappers = widget.querySelectorAll('.hs-wrapper');
                    for (let i = 0; i < wrappers.length; i++) {
                        const wrapper = wrappers[i];
                        const clickable = wrapper.querySelector('.clickable[data-identifier]');
                        if (!clickable) continue;
                        const id = clickable.dataset.identifier;
                        const label = clickable.getAttribute('aria-label') || `Hotspot ${i + 1}`;
                        const style = wrapper.getAttribute('style') || '';
                        const topMatch = style.match(/top:\s*([^;]+)/);
                        const leftMatch = style.match(/left:\s*([^;]+)/);
                        const position = (topMatch && leftMatch) ? `top:${topMatch[1].trim()}, left:${leftMatch[1].trim()}` : '';
                        hotspots.push({ id, label, position, index: i + 1 });
                    }

                    if (hotspots.length > 0) {
                        const images = Ed.Parsers.getImageInfo(widget, d);
                        return { question, hotspots, doc: d, widget, type: 'hotspot', images };
                    }
                }
            }
            return null;
        },

        buildPrompt: (data) => {
            let wrongFeedback = '';
            if (data.previousWrong) {
                wrongFeedback = `CRITICAL: You already answered this question and got it WRONG. Your previous incorrect answer was: "${data.previousWrong}".\nYou are FORBIDDEN from giving the same answer again. You MUST choose a COMPLETELY DIFFERENT answer. Do not repeat "${data.previousWrong}" under any circumstances.\n\n`;
            }

            const imgSection = Ed.Parsers.formatImageInfo(data.images);
            let strictSuffix = '';
            if (data._strictRetry) {
                strictSuffix = `\n\nCRITICAL: Your previous response contained extra text, formatting, or explanation and could not be parsed. This time output ONLY the raw answer with no labels, no markdown, no sentences, and no punctuation around it. Just the answer exactly as requested.`;
            }

            // Injected instruction to force short reasoning on cutoff recovery
            let shortSuffix = '';
            if (data._shortRetry) {
                shortSuffix = `\n\nCRITICAL WARNING: Your previous response was cut off because your reasoning was too long. Do not write a long reasoning block this time. Limit your [REASONING] section to a maximum of 2 sentences and write the [FINAL ANSWER] immediately.`;
            }

            // Combined suffixes to keep prompt code clean
            const suffix = strictSuffix + shortSuffix;

            if (data.type === 'mcq') {
                let prompt = wrongFeedback + `Answer this multiple choice question with ONLY the letter (A, B, C, D, etc.) of the correct choice.\n\nQuestion:\n${data.question}${imgSection}\n\nChoices:\n`;
                data.choices.forEach(c => {
                    prompt += `${c.letter}) ${c.text}\n`;
                });
                       prompt += `
Respond with ONLY the letter. No explanation. No punctuation. No extra text of any kind.` + suffix;
       return prompt;
   }
   if (data.type === 'multiresponse') {
       let prompt = wrongFeedback + `Answer this multiple response question. Select ALL correct options.
Question:
${data.question}${imgSection}
Choices:
`;
       data.choices.forEach(c => {
           prompt += `${c.letter}) ${c.text}
`;
       });
       prompt += `
Respond with ONLY the letters of the correct choices, separated by commas (e.g., A,C). No explanation. No extra text.` + suffix;
       return prompt;
   }
   if (data.type === 'hottext') {
       let prompt = wrongFeedback + `Answer this text selection question. Select the correct phrase(s) from the options.
Question:
${data.question}${imgSection}
Options:
`;
       data.choices.forEach(c => {
           prompt += `${c.letter}) ${c.text}
`;
       });
       prompt += `
Respond with ONLY the letter(s) of the correct option(s), separated by commas if multiple. No explanation. No extra text.` + suffix;
       return prompt;
   }
      if (data.type === 'ggm') {
       let prompt = wrongFeedback + `You are answering a drag-and-drop categorization question.
Question:
${data.question}${imgSection}
`;
       prompt += `Available draggable tiles:
`;
       data.draggables.forEach(t => {
           prompt += `- ${t.text}
`;
       });
       prompt += `
Drop zones (categories):
`;
       data.droppables.forEach((z, i) => {
           const labelInfo = z.label && !z.label.includes('Empty') ? ` [${z.label}]` : '';
           prompt += `${i + 1}. ${z.positionDesc}${labelInfo}
`;
       });
       prompt += `
CRITICAL: Multiple tiles can belong to the SAME drop zone. You must categorize EVERY single tile. Do not leave any tiles unused.
Respond with ONLY the mappings in this exact format:
Zone 1: tile text, tile text
Zone 2: tile text, tile text
(Use the exact tile text from the list above. Separate multiple tiles in the same zone with commas.)
Do not include any reasoning, explanations, or extra text.` + strictSuffix;
       return prompt;
   }

            if (data.type === 'mpsimple') {
                let prompt = wrongFeedback + `You are answering a drag-and-drop pairing question.\n\nQuestion:\n${data.question}${imgSection}\n\n`;
                prompt += `Available tiles:\n`;
                data.draggables.forEach(t => {
                    prompt += `- ${t.text}\n`;
                });
                prompt += `\nDrop zones:\n`;
                data.droppables.forEach((z, i) => {
                    prompt += `${i + 1}. ${z.label}\n`;
                });
                prompt += `\nTell me which tile text belongs in each drop zone. You must form logical pairs in each row based on the question (e.g., matching dimensions to area).\n`;
                prompt += `Respond with ONLY the tile TEXT VALUES, separated by commas, in the same order as the drop zones above (Row r0 Left Box, Row r0 Right Box, etc.).\n`;
                prompt += `Do not include any reasoning, explanations, or extra text.\n`;
                return prompt + strictSuffix;
            }

            if (data.type === 'matchedpairs') {
                let prompt = wrongFeedback + `You are answering a drag-and-drop matching question.\n\nQuestion:\n${data.question}${imgSection}\n\n`;
                prompt += `Left items to match (ID → value):\n`;
                data.leftItems.forEach(item => {
                    prompt += `- ${item.id}: ${item.text}\n`;
                });
                prompt += `\nAvailable draggable tiles (ID → value):\n`;
                data.draggables.forEach(t => {
                    prompt += `- ${t.id}: ${t.text}\n`;
                });
                prompt += `\nMap each LEFT ITEM ID to the correct TILE ID.\n`;
                prompt += `Respond ONLY in this exact format: leftItemId:tileId,leftItemId:tileId\n`;
                prompt += `Do not include any explanations or extra text.\n`;
                prompt += `Example: a111:a222,a333:a444` + strictSuffix;
                return prompt;
            }

            if (data.type === 'textentry') {
                let prompt = wrongFeedback + `Answer this fill-in-the-blank question. Provide the value for each blank box.\n\nQuestion:\n${data.question}${imgSection}\n\nExpression/template (fill in each {N}):\n${data.template}\n\nRespond with ONLY the values for each box, separated by commas, in the order of the boxes {1}, {2}, etc.\nDo not include any explanations, units, or extra text.\nExample: -3, 4, 12.5` + strictSuffix;
                return prompt;
            }

            if (data.type === 'seqresponse') {
                let prompt = wrongFeedback + `You are answering a sequence/ordering question. Place the correct tiles in the correct order in the drop zones. NOT all tiles will be used — some are distractors.

Question:
${data.question}${imgSection}

`;
                prompt += `Available tiles (some are distractors, not all will be used):
`;
                data.draggables.forEach((t, i) => {
                    prompt += `${t.letter}. ${t.text}`;
                    if (t.mathText) prompt += ` [Equation: ${t.mathText}]`;
                    prompt += `\n`;
                });
                prompt += `\nDrop zones (in order):\n`;
                data.droppables.forEach((z, i) => {
                    prompt += `${i + 1}. ${z.label}\n`;
                });
                prompt += `\nTell me which tiles belong in each drop zone, in the correct order.\n`;
                prompt += `Respond with ONLY the LETTER of each tile (A, B, C, etc.) in order of the drop zones, separated by commas.\n`;
                prompt += `Tiles that are NOT used should be omitted.\n`;
                prompt += `Do not include any reasoning, explanations, or extra text.\n`;
                prompt += `Example: A,C,E  (meaning tile A goes in zone 1, tile C in zone 2, tile E goes in zone 3)` + strictSuffix;
                return prompt;
            }

            if (data.type === 'inlinechoice') {
                let prompt = wrongFeedback + `Answer this fill-in-the-blank question with drop-down menus. Select the correct option for each menu.\n\nQuestion:\n${data.question}${imgSection}\n\nSentence with blanks:\n${data.template}\n\n`;
                data.menus.forEach(menu => {
                    prompt += `Menu ${menu.index} options:\n`;
                    menu.options.forEach(o => {
                        prompt += `${o.letter}) ${o.text}\n`;
                    });
                    prompt += `\n`;
                });
                prompt += `Respond with ONLY the letters for each menu, separated by commas, in order of the menus (Menu 1, Menu 2, etc.).\nDo not include any explanations or extra text.\nExample: B,D` + strictSuffix;
                return prompt;
            }

            if (data.type === 'hotspot') {
                let prompt = wrongFeedback + `You are answering a hotspot question. Click the correct location on the image.\n\nQuestion:\n${data.question}${imgSection}\n\nHotspot locations (respond with the number):\n`;
                data.hotspots.forEach(h => {
                    prompt += `${h.index}. ${h.label} [${h.position}]\n`;
                });
                prompt += `\nRespond with ONLY the number of the correct hotspot. Example: 2\nDo not include any explanation.` + strictSuffix;
                return prompt;
            }
            return '';
        },

        parseAnswer: (text, choices) => {
            const cleaned = Ed.AI.cleanAIResponse(text);
            const normalized = cleaned.toUpperCase().replace(/[.*)\]]/g, '').trim();

            // 1. Exact match of the letter
            const exact = choices.find(c => {
                const letter = c.letter.replace(/[.\s)]/g, '').toUpperCase();
                return letter && normalized === letter; // Guard: skip empty strings
            });
            if (exact) return exact;

            // 2. Strict word boundary match (prevents matching letter "A" inside words like "ANSWER")
            for (const c of choices) {
                const letter = c.letter.replace(/[.\s)]/g, '').toUpperCase();
                if (!letter) continue; // Guard: skip empty strings
                const regex = new RegExp('\\b' + letter + '\\b');
                if (regex.test(normalized)) return c;
            }

            // 3. Match using ID
            for (const c of choices) {
                if (c.id && normalized.includes(c.id.toUpperCase())) return c;
            }

            // 4. Exact text fallback
            const lowerCleaned = cleaned.toLowerCase().trim();
            for (const c of choices) {
                const choiceText = (c.text || '').toLowerCase().trim();
                if (choiceText && (lowerCleaned === choiceText || lowerCleaned.includes(choiceText))) return c;
            }
            return null;
        },

        parseMultipleResponseAnswer: (text, choices) => {
            const cleaned = Ed.AI.cleanAIResponse(text);
            const results = [];
            const normalized = cleaned.toUpperCase();
            const parts = normalized.split(/[,;]/).map(p => p.trim().replace(/[.*)\]]/g, '')).filter(Boolean);

            for (const part of parts) {
                // Exact letter match
                const exact = choices.find(c => {
                    const letter = c.letter.replace(/[.\s)]/g, '').toUpperCase();
                    return letter && part === letter; // Guard: skip empty strings
                });
                if (exact && !results.find(r => r.id === exact.id)) {
                    results.push(exact);
                    continue;
                }
                // Word boundary check (ensures target letter is standalone)
                for (const c of choices) {
                    const letter = c.letter.replace(/[.\s)]/g, '').toUpperCase();
                    if (!letter) continue; // Guard: skip empty strings
                    const regex = new RegExp('\\b' + letter + '\\b');
                    if (regex.test(part) && !results.find(r => r.id === c.id)) {
                        results.push(c);
                        break;
                    }
                }
            }

            if (results.length === 0) {
                const lowerCleaned = cleaned.toLowerCase();
                for (const c of choices) {
                    const choiceText = (c.text || '').toLowerCase().trim();
                    if (choiceText && lowerCleaned.includes(choiceText) && !results.find(r => r.id === c.id)) {
                        results.push(c);
                    }
                }
            }
            return results;
        },

        findBestTile: (val, draggables) => {
            const normVal = val.toLowerCase()
                .replace(/startroot/g, '√')
                .replace(/endroot/g, '')
                .replace(/sqrt/g, '√')
                .replace(/\s+/g, '');

            let tile = draggables.find(t => t.text === val);
            if (tile) return tile;

            tile = draggables.find(t => {
                const normTile = t.text.toLowerCase()
                    .replace(/startroot/g, '√')
                    .replace(/endroot/g, '')
                    .replace(/sqrt/g, '√')
                    .replace(/\s+/g, '');
                return normTile === normVal;
            });
            if (tile) return tile;

            const contained = draggables.filter(t => {
                const normTile = t.text.toLowerCase()
                    .replace(/startroot/g, '√')
                    .replace(/endroot/g, '')
                    .replace(/sqrt/g, '√')
                    .replace(/\s+/g, '');
                return normVal.includes(normTile);
            }).sort((a, b) => b.text.length - a.text.length);
            if (contained.length > 0) return contained[0];

            const reversed = draggables.filter(t => {
                const normTile = t.text.toLowerCase()
                    .replace(/startroot/g, '√')
                    .replace(/endroot/g, '')
                    .replace(/sqrt/g, '√')
                    .replace(/\s+/g, '');
                return normTile.includes(normVal) && normTile.length <= normVal.length + 3;
            }).sort((a, b) => a.text.length - b.text.length);
            if (reversed.length > 0) return reversed[0];

            return null;
        },

       parseGGMAnswer: (text, data) => {
    const cleaned = Ed.AI.cleanAIResponse(text);
    const mapping = {}; // Will store { dropId: [tileId1, tileId2] }

    // Initialize mapping arrays for each drop zone
    data.droppables.forEach(z => { mapping[z.id] = []; });

    // Split response by lines to handle "Zone X: tile, tile" format
    const lines = cleaned.split(/\n/).map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        // Match patterns like "Zone 1: tile text, tile text" or "1: tile text"
        const zoneMatch = line.match(/^(?:zone|drop\s*zone|category)\s*(\d+)\s*[:\-]\s*(.*)/i);
        if (zoneMatch) {
            const zoneIndex = parseInt(zoneMatch[1]) - 1;
            const tileTexts = zoneMatch[2].split(/[,;]/).map(t => t.trim()).filter(Boolean);

            if (zoneIndex >= 0 && zoneIndex < data.droppables.length) {
                const dropId = data.droppables[zoneIndex].id;
                for (const tText of tileTexts) {
                    const tile = Ed.Parsers.findBestTile(tText, data.draggables);
                    if (tile && !mapping[dropId].includes(tile.id)) {
                        mapping[dropId].push(tile.id);
                    }
                }
            }
        }
    }

    // Fallback: If AI just listed tiles sequentially without zone labels
    if (Object.values(mapping).every(arr => arr.length === 0)) {
        const allTexts = cleaned.split(/[,;\n]/).map(t => t.trim()).filter(Boolean);
        let zoneIdx = 0;
        for (const tText of allTexts) {
            const tile = Ed.Parsers.findBestTile(tText, data.draggables);
            if (tile) {
                const dropId = data.droppables[zoneIdx % data.droppables.length].id;
                if (!mapping[dropId].includes(tile.id)) {
                    mapping[dropId].push(tile.id);
                }
                zoneIdx++;
            }
        }
    }

    return mapping;
},

        parseMatchedPairsAnswer: (text, data) => {
            const cleaned = Ed.AI.cleanAIResponse(text);
            const mapping = {};
            const parts = cleaned.split(/[,;]/);

            for (const part of parts) {
                if (!part.includes(':')) continue;
                const [leftId, tileId] = part.trim().split(':');
                if (leftId && tileId) {
                    const lId = leftId.trim();
                    const tId = tileId.trim();
                    const leftExists = data.leftItems.some(item => item.id === lId);
                    const tileExists = data.draggables.some(t => t.id === tId);
                    if (leftExists && tileExists) mapping[lId] = tId;
                }
            }
            if (Object.keys(mapping).length > 0) return mapping;

            for (const part of parts) {
                if (!part.includes(':')) continue;
                const [leftText, tileText] = part.trim().split(':').map(s => s.trim());
                if (!leftText || !tileText) continue;

                const leftItem = data.leftItems.find(item =>
                    item.text.toLowerCase().includes(leftText.toLowerCase()) ||
                    leftText.toLowerCase().includes(item.text.toLowerCase())
                );
                const tile = data.draggables.find(t =>
                    t.text.toLowerCase().includes(tileText.toLowerCase()) ||
                    tileText.toLowerCase().includes(t.text.toLowerCase())
                );
                if (leftItem && tile) mapping[leftItem.id] = tile.id;
            }

            return mapping;
        },

        parseTextEntryAnswer: (text, data) => {
            const cleaned = Ed.AI.cleanAIResponse(text);
            const normalized = cleaned.replace(/−/g, '-').replace(/–/g, '-');
            let parts = normalized.split(/[,;]/).map(s => s.trim()).filter(Boolean);
            parts = parts.map(p => p.replace(/^["'`]+|["'`]+$/g, ''));

            const result = {};
            data.inputs.forEach((input, i) => {
                result[input.index] = parts[i] !== undefined ? parts[i] : '';
            });
            return result;
        },

        parseSeqResponseAnswer: (text, data) => {
            const cleaned = Ed.AI.cleanAIResponse(text);
            const letters = cleaned.split(/[,;]/).map(s => s.trim().replace(/[.\s)]/g, '').toUpperCase()).filter(Boolean);

            const mapping = {};
            for (let i = 0; i < data.droppables.length && i < letters.length; i++) {
                const letter = letters[i];
                const idx = letter.charCodeAt(0) - 65;
                if (idx >= 0 && idx < data.draggables.length) {
                    mapping[data.droppables[i].id] = data.draggables[idx].id;
                }
            }
            return mapping;
        },

        parseInlineChoiceAnswer: (text, data) => {
            const cleaned = Ed.AI.cleanAIResponse(text);
            const parts = cleaned.split(/[,;]/).map(s => s.trim().replace(/[.\s)]/g, '').toUpperCase()).filter(Boolean);
            const result = {};
            data.menus.forEach((menu, i) => {
                const part = parts[i] || '';
                const option = menu.options.find(o => o.letter === part);
                if (option) {
                    result[menu.index] = option.value;
                } else {
                    const textMatch = menu.options.find(o => o.text.toLowerCase() === part.toLowerCase());
                    if (textMatch) result[menu.index] = textMatch.value;
                }
            });
            return result;
        },

        parseHotspotAnswer: (text, data) => {
            const cleaned = Ed.AI.cleanAIResponse(text).trim();
            const match = cleaned.match(/^(\d+)$/);
            if (match) {
                const idx = parseInt(match[1]) - 1;
                if (idx >= 0 && idx < data.hotspots.length) return data.hotspots[idx];
            }
            const anyNum = cleaned.match(/(\d+)/);
            if (anyNum) {
                const idx = parseInt(anyNum[1]) - 1;
                if (idx >= 0 && idx < data.hotspots.length) return data.hotspots[idx];
            }
            for (const h of data.hotspots) {
                if (cleaned.toLowerCase().includes(h.label.toLowerCase())) return h;
            }
            return null;
        }
    };

    // ========================================================================
    // ACTION HANDLERS (Clicking answers)
    // ========================================================================
    Ed.Actions = {
        answerMultipleResponse: async (data, selectedChoices) => {
            const mr = data.widget;
            if (!mr) return false;

            const allChecks = mr.querySelectorAll('input[type="checkbox"]');
            for (const cb of allChecks) {
                if (cb.checked) {
                    cb.click();
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    await Ed.Utils.delayAsync(100);
                }
            }

            for (const choice of selectedChoices) {
                const input = mr.querySelector(`input[type="checkbox"][data-identifier="${choice.id}"]`);
                if (input && !input.checked) {
                    input.click();
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    await Ed.Utils.delayAsync(200);
                }
            }
            return true;
        },

        answerHottext: async (data, selectedChoices) => {
            if (!data.widget) return false;

            const allSpans = data.widget.querySelectorAll('.hottext-mc-span, .hottext-mr-span');
            for (const span of allSpans) {
                if (span.getAttribute('aria-pressed') === 'true') {
                    span.click();
                    await Ed.Utils.delayAsync(100);
                }
            }

            for (const choice of selectedChoices) {
                const span = choice.el;
                if (span && span.getAttribute('aria-pressed') !== 'true') {
                    span.click();
                    await Ed.Utils.delayAsync(200);
                }
            }
            return true;
        },

        answerGGM: async (data, mapping) => {
    const ggm = data.widget;
    if (!ggm) return false;
    const entries = Object.entries(mapping);
    for (const [dropId, tileIds] of entries) {
        // tileIds is now an array of tile IDs for this drop zone
        const tileIdArray = Array.isArray(tileIds) ? tileIds : [tileIds];
        for (const tileId of tileIdArray) {
            const zone = ggm.querySelector(`.droppable.target[data-identifier="${dropId}"]`);
            if (!zone) continue;
            const tile = ggm.querySelector(`.draggable-item[data-identifier="${tileId}"]`);
            if (!tile) continue;
            if (tile.dataset.dropped === 'true') continue;

                if (tile.dataset.dropped === 'true') continue;

                tile.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                tile.focus();
                await Ed.Utils.delayAsync(100);
                tile.click();
                await Ed.Utils.delayAsync(300);

                zone.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                zone.focus();
                await Ed.Utils.delayAsync(100);
                zone.click();
                await Ed.Utils.delayAsync(500);

                const hasItem = zone.querySelector('.draggable-item, .gapmatch-item, [data-identifier]') !== null;
                if (hasItem) continue;

                tile.focus();
                await Ed.Utils.delayAsync(100);
                tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(50);
                tile.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(300);

                zone.focus();
                await Ed.Utils.delayAsync(100);
                zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(50);
                zone.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(500);

                const hasItemKeyboard = zone.querySelector('.draggable-item, .gapmatch-item, [data-identifier]') !== null;
                if (hasItemKeyboard) continue;

                const tileRect = tile.getBoundingClientRect();
                const zoneRect = zone.getBoundingClientRect();

                const mouseDown = new MouseEvent('mousedown', {
                    bubbles: true, cancelable: true,
                    clientX: tileRect.left + tileRect.width / 2,
                    clientY: tileRect.top + tileRect.height / 2,
                    button: 0
                });
                tile.dispatchEvent(mouseDown);
                await Ed.Utils.delayAsync(100);

                const mouseMove = new MouseEvent('mousemove', {
                    bubbles: true, cancelable: true,
                    clientX: zoneRect.left + zoneRect.width / 2,
                    clientY: zoneRect.top + zoneRect.height / 2,
                    button: 0
                });
                document.dispatchEvent(mouseMove);
                await Ed.Utils.delayAsync(100);

                const mouseUp = new MouseEvent('mouseup', {
                    bubbles: true, cancelable: true,
                    clientX: zoneRect.left + zoneRect.width / 2,
                    clientY: zoneRect.top + zoneRect.height / 2,
                    button: 0
                });
                zone.dispatchEvent(mouseUp);
                            await Ed.Utils.delayAsync(500);
        }
        } // Close inner tileIdArray loop
        await Ed.Utils.delayAsync(800);
        // Fallback sweep
            let remainingEmpty = Array.from(ggm.querySelectorAll('.droppable.target')).filter(z => {
                return z.querySelector('.draggable-item, .gapmatch-item, [data-identifier]') === null;
            });

            if (remainingEmpty.length > 0) {
                for (const zone of remainingEmpty) {
                    const zoneId = zone.dataset.identifier;
                    const tileId = mapping[zoneId];
                    if (!tileId) continue;
                    const tile = ggm.querySelector(`.draggable-item[data-identifier="${tileId}"]`);
                    if (!tile) continue;
                    tile.click(); await Ed.Utils.delayAsync(200);
                    zone.click(); await Ed.Utils.delayAsync(400);
                }
                await Ed.Utils.delayAsync(600);
            }

            return true;
        },

        answerMPSimple: async (data, mapping) => {
            const widget = data.widget;
            if (!widget) return false;

            for (const [dropId, tileId] of Object.entries(mapping)) {
                const zone = widget.querySelector(`.droppable.ui-droppable[data-droppableid="${dropId}"]`) ||
                             widget.querySelector(`.droppable.ui-droppable[data-safedroppableid="${dropId}"]`);
                if (!zone) continue;

                const tile = widget.querySelector(`.draggable-item[data-identifier="${tileId}"]`);
                if (!tile) continue;

                if (tile.dataset.dropped === 'true') continue;

                tile.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                tile.focus();
                await Ed.Utils.delayAsync(100);
                tile.click();
                await Ed.Utils.delayAsync(300);

                zone.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                zone.focus();
                await Ed.Utils.delayAsync(100);
                zone.click();
                await Ed.Utils.delayAsync(500);

                if (tile.dataset.dropped === 'true') continue;

                tile.focus();
                await Ed.Utils.delayAsync(100);
                tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(50);
                tile.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(300);

                zone.focus();
                await Ed.Utils.delayAsync(100);
                zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(50);
                zone.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(500);
            }
            await Ed.Utils.delayAsync(800);
            return true;
        },

        answerMatchedPairs: async (data, mapping) => {
            const mp = data.widget;
            if (!mp) return false;

            const total = Object.keys(mapping).length;
            if (total === 0) return false;

            for (const [leftId, tileId] of Object.entries(mapping)) {
                const leftItem = mp.querySelector(`.match.answer-display[data-identifier="${leftId}"]`);
                if (!leftItem) continue;

                const wrapper = leftItem.closest('.droppable-wrapper');
                if (!wrapper) continue;

                const zone = wrapper.querySelector('.droppable.ui-droppable');
                if (!zone) continue;

                const tile = mp.querySelector(`.draggable-item[data-identifier="${tileId}"]`);
                if (!tile) continue;

                if (tile.dataset.dropped === 'true') {
                    continue;
                }

                tile.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                tile.focus();
                await Ed.Utils.delayAsync(100);
                tile.click();
                await Ed.Utils.delayAsync(300);

                zone.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                zone.focus();
                await Ed.Utils.delayAsync(100);
                zone.click();
                await Ed.Utils.delayAsync(500);

                if (tile.dataset.dropped === 'true') {
                    continue;
                }

                tile.focus();
                await Ed.Utils.delayAsync(100);
                tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
                await Ed.Utils.delayAsync(50);
                tile.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
                await Ed.Utils.delayAsync(300);

                zone.focus();
                await Ed.Utils.delayAsync(100);
                zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
                await Ed.Utils.delayAsync(50);
                zone.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
                await Ed.Utils.delayAsync(500);

                if (tile.dataset.dropped === 'true') {
                    continue;
                }

                const tileRect = tile.getBoundingClientRect();
                const zoneRect = zone.getBoundingClientRect();

                const mouseDown = new MouseEvent('mousedown', {
                    bubbles: true, cancelable: true,
                    clientX: tileRect.left + tileRect.width / 2,
                    clientY: tileRect.top + tileRect.height / 2,
                    button: 0
                });
                tile.dispatchEvent(mouseDown);
                await Ed.Utils.delayAsync(100);

                const mouseMove = new MouseEvent('mousemove', {
                    bubbles: true, cancelable: true,
                    clientX: zoneRect.left + zoneRect.width / 2,
                    clientY: zoneRect.top + zoneRect.height / 2,
                    button: 0
                });
                document.dispatchEvent(mouseMove);
                await Ed.Utils.delayAsync(100);

                const mouseUp = new MouseEvent('mouseup', {
                    bubbles: true, cancelable: true,
                    clientX: zoneRect.left + zoneRect.width / 2,
                    clientY: zoneRect.top + zoneRect.height / 2,
                    button: 0
                });
                zone.dispatchEvent(mouseUp);
                await Ed.Utils.delayAsync(500);
            }

            await Ed.Utils.delayAsync(800);
            return true;
        },

        answerTextEntry: async (data, values) => {
            const widget = data.widget;
            if (!widget) return false;

            let filled = 0;
            for (const input of data.inputs) {
                const val = values[input.index];
                if (val === undefined || val === '') continue;

                const el = input.el || widget.querySelector(`input#${input.id}`) || widget.querySelector(`input[name="${input.name}"]`);
                if (!el) continue;

                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                el.focus();

                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                await Ed.Utils.delayAsync(50);

                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));

                await Ed.Utils.delayAsync(200);
                filled++;
            }
            return filled === data.inputs.length;
        },

        answerSeqResponse: async (data, mapping) => {
            const seq = data.widget;
            if (!seq) return false;

            const entries = Object.entries(mapping);

            for (const [dropId, tileId] of entries) {
                const zone = seq.querySelector(`.droppable[data-position="${dropId}"]`);
                if (!zone) continue;

                const tile = seq.querySelector(`.draggable-item[data-identifier="${tileId}"]`);
                if (!tile) continue;

                if (tile.dataset.dropped === 'true') continue;

                tile.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                tile.focus();
                await Ed.Utils.delayAsync(100);

                tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(50);
                tile.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(300);

                zone.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                zone.focus();
                await Ed.Utils.delayAsync(100);

                zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(50);
                zone.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                await Ed.Utils.delayAsync(500);

                const hasItem = zone.querySelector('.draggable-item, .seq-item, [data-identifier]') !== null;
                if (hasItem) continue;

                tile.click();
                await Ed.Utils.delayAsync(300);
                zone.click();
                await Ed.Utils.delayAsync(500);
            }

            await Ed.Utils.delayAsync(600);
            return true;
        },

        answerInlineChoice: async (data, mapping) => {
            const widget = data.widget;
            if (!widget) return false;
            let filled = 0;
            for (const menu of data.menus) {
                const val = mapping[menu.index];
                if (!val) continue;
                const select = menu.el || widget.querySelector(`select#${menu.id}`) || widget.querySelector(`select[name="${menu.name}"]`);
                if (!select) continue;
                select.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
                await Ed.Utils.delayAsync(150);
                select.focus();
                select.value = val;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                await Ed.Utils.delayAsync(200);
                filled++;
            }
            return filled === data.menus.length;
        },

        answerHotspot: async (data, hotspot) => {
            const widget = data.widget;
            if (!widget || !hotspot) return false;
            const el = widget.querySelector(`.clickable[data-identifier="${hotspot.id}"]`);
            if (!el) return false;
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
            await Ed.Utils.delayAsync(150);
            el.focus();
            await Ed.Utils.delayAsync(100);
            el.click();
            await Ed.Utils.delayAsync(100);
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            await Ed.Utils.delayAsync(50);
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            await Ed.Utils.delayAsync(50);
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            await Ed.Utils.delayAsync(200);
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            await Ed.Utils.delayAsync(50);
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            await Ed.Utils.delayAsync(300);
            return true;
        }
    };

    // ========================================================================
    // AUTO ANSWER
    // ========================================================================
    Ed.Answer = {
            isOkToExit: (d) => {
        // STRICT: Use your exact progress HTML structure
        const progressEl = d.querySelector('.progressSummaryItem h2.progressSummaryLabel-question span.progressSummary-question, .progressSummary-question, span.progressSummary-question');
        if (!progressEl) return false; // Not loaded yet = DO NOT EXIT

        const text = progressEl.textContent.trim();
        const match = text.match(/(\d+)\s+of\s+(\d+)/i);
        if (!match) return false; // Can't parse = DO NOT EXIT

        const current = parseInt(match[1]);
        const total = parseInt(match[2]);
        if (current < total) return false; // Not on last question = DO NOT EXIT

        // If on last question, check if ANY submit/next button is still visible.
        // If visible, the question isn't answered/submitted yet = DO NOT EXIT
        const submitSelectors = '.worksheets-submit, .test-player-nav-next, button[aria-label*="Submit Answer"], button[aria-label*="Next"], .player-button.worksheets-next';
        const submitBtn = d.querySelector(submitSelectors);
        if (submitBtn && Ed.Utils.isVisible(submitBtn, d)) return false;

        return true; // Only true if on last question AND submit button is hidden/gone
    },
        isEndOfTest: (d) => {
        // Returns true if we are on the last question and it's answered, BUT NOT on the results screen yet.
        // NOTE: #exit-session-btn is REMOVED because it exists in the header from Q1 and causes false negatives.
        if (d.querySelector('#results-wrapper, .assessment-results, .test-results')) return false;
        const progressEl = d.querySelector('.progressSummaryItem h2.progressSummaryLabel-question span.progressSummary-question, .progressSummary-question, span.progressSummary-question');
        if (!progressEl) return false;
        const text = progressEl.textContent.trim();
        const match = text.match(/(\d+)\s+of\s+(\d+)/i);
        if (!match) return false;
        const current = parseInt(match[1]);
        const total = parseInt(match[2]);
        if (current < total) return false;
        const submitBtn = d.querySelector('.worksheets-submit, .test-player-nav-next, button[aria-label*="Submit Answer"], button[aria-label*="Next"]');
        if (submitBtn && Ed.Utils.isVisible(submitBtn, d)) return false;
        return true;
    },
clickSubmitOrNext: async (preferredDoc) => {
            const docs = preferredDoc ? [preferredDoc] : Ed.Utils.getDocs();
            let foundBtn = null;

            const selectors = [
                'a.player-button.worksheets-submit',
                'a.worksheets-submit',
                '[id^="section-"] a.worksheets-submit',
                '.test-player-nav-next',
                '.test-nav-next',
                '#test-player-next',
                'button[aria-label*="Next"]',
                'button[aria-label*="Submit Answer"]',
                'button[aria-label="Next Question"]',
                'a.worksheets-next',
                '.player-button.worksheets-next',
                '[id^="section-"] a.worksheets-next',
                // Worksheets completion buttons added as final fallbacks
                'a.player-button.worksheets-endsession',
                'a.worksheets-endsession'
            ];

            for (const d of docs) {
                for (const sel of selectors) {
                    const btns = Array.from(d.querySelectorAll(sel));
                    for (const btn of btns) {
                        if (Ed.Utils.isClickable(btn, d)) {
                            foundBtn = btn;
                            break;
                        }
                    }
                    if (foundBtn) break;
                }
                if (foundBtn) break;
            }

            if (!foundBtn) {
                for (const d of docs) {
                    const candidates = Array.from(d.querySelectorAll('a, button')).filter(el => Ed.Utils.isClickable(el, d));
                    for (const btn of candidates) {
                        const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
                        if (text === 'submit answer' || text === 'next question' || text === 'next' || text === 'continue' || text === 'submit') {
                            if (text.includes('test') || text.includes('session')) continue; // Ignore "Submit Test" and "End Session"
                            foundBtn = btn;
                            break;
                        }
                    }
                    if (foundBtn) break;
                }
            }

              if (foundBtn) {
        const doc = preferredDoc || document;
        const isResultsScreen = !!doc.querySelector('#results-wrapper, .assessment-results, .test-results, #exit-session-btn');
        const isLastQuestion = Ed.Answer.isEndOfTest(doc);
        const btnText = (foundBtn.textContent || foundBtn.innerText || '').toLowerCase().trim();
        const isFinalSubmitBtn = btnText.includes('submit test') || btnText.includes('end session') || btnText.includes('finish test') || foundBtn.matches('.worksheets-endsession, [aria-label*="Submit Test"]');

        // Trigger confirmation modal if we are at the end of the test and haven't confirmed yet
        if (!isResultsScreen && (isLastQuestion || isFinalSubmitBtn) && Ed.Config.get('CONFIRM_SUBMIT', false) && !Ed.State.hasConfirmedSubmission) {
            Ed.Utils.setStatus('AWAITING_MANUAL');
            const confirmed = await Ed.Nav.showConfirmModal();
            if (!confirmed) {
                Ed.Utils.setStatus('IDLE');
                return false;
            }
            Ed.State.hasConfirmedSubmission = true;
            Ed.Utils.setStatus('SOLVING');
        }

        foundBtn.click();
        return true;
    }
    return false;
},
        handleSaveExitDialog: async () => {
            for (const d of Ed.Utils.getDocs()) {
                // 1. Handle confirmation dialogs FIRST (Submit Test / Save & Exit popups)
                const dialogs = d.querySelectorAll('.ui-dialog');
                for (const dialog of dialogs) {
                    if (!Ed.Utils.isVisible(dialog, d)) continue;
                    const titleEl = dialog.querySelector('.ui-dialog-title');
                    const msgEl = dialog.querySelector('#dialog-message, .ui-dialog-content, #finished-dialog');
                    const titleText = titleEl ? titleEl.textContent.trim().toLowerCase() : '';
                    const msgText = msgEl ? msgEl.textContent.toLowerCase() : '';
                    const isSubmitDialog = titleText.includes('submit test') || msgText.includes('once your test is graded');
                    const isSaveExitDialog = titleText.includes('save and exit') || msgText.includes('save for later');
                    if (isSubmitDialog || isSaveExitDialog) {
                        const okBtn = dialog.querySelector('.ui-dialog-buttonset button.blue') ||
                                      dialog.querySelector('.ui-dialog-buttonset button.green') ||
                                      dialog.querySelector('.ui-dialog-buttonset button:first-child') ||
                                      Array.from(dialog.querySelectorAll('button')).find(b => {
                                          const txt = b.textContent.trim().toUpperCase();
                                          return txt === 'OK' || txt === 'YES' || txt === 'SUBMIT';
                                      });
                        if (okBtn && Ed.Utils.isClickable(okBtn, d)) {
                            if (isSubmitDialog && Ed.Config.get('CONFIRM_SUBMIT', false) && !Ed.State.hasConfirmedSubmission) {
                                Ed.Utils.setStatus('AWAITING_MANUAL');
                                const confirmed = await Ed.Nav.showConfirmModal();
                                if (!confirmed) { Ed.Utils.setStatus('IDLE'); return true; }
                                Ed.State.hasConfirmedSubmission = true;
                                Ed.Utils.setStatus('SOLVING');
                            }
                            Ed.UI.showToast(isSaveExitDialog ? 'Save & Exit dialog detected — clicking OK' : 'Confirming submission...', 2000);
                            okBtn.click();
                            okBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                            okBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                            okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            if (isSubmitDialog) { Ed.Answer.stopAnswer(); Ed.UI.showToast('Test submitted!', 3000); }
                            return true;
                        }
                    }
                }

                // 2. HARD GATE: DO NOT scan for exit buttons unless we are on the actual results screen OR the final question is answered.
                // We explicitly IGNORE #exit-session-btn here because it exists in the header from Q1.
                const isResultsScreen = !!d.querySelector('#results-wrapper, .assessment-results, .test-results');
                const isFinalQuestionAnswered = Ed.Answer.isOkToExit(d);
                if (!isResultsScreen && !isFinalQuestionAnswered) continue;

                // 3. Find exit buttons, but STRICTLY EXCLUDE header/nav buttons to prevent premature clicks
                const allExitBtns = Array.from(d.querySelectorAll('button[aria-label="Save and Exit"], button.rbi-btn.floatright, #exit-session-btn > button'));
                for (const btn of allExitBtns) {
                    // CRITICAL: Skip if button is inside a header, nav, or top bar
                    if (btn.closest('header, nav, .header-wrapper, .top-nav, .global-nav, .rbi-top-nav')) continue;
                    if (!Ed.Utils.isClickable(btn, d)) continue;

                    Ed.UI.showToast('Assignment complete — closing...', 2000);
                    btn.click();
                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    await Ed.Utils.delayAsync(1000);
                    return true;
                }
            }
            return false;
        },

        clickNextQuestion: () => {
            function isInsideQuestionWidget(el) {
                let node = el;
                while (node && node !== document.body) {
                    if (node.classList && (
                        node.classList.contains('interactive-template') ||
                        node.classList.contains('multichoice') ||
                        node.classList.contains('multiresponse') ||
                        node.classList.contains('text-entry-content') ||
                        node.classList.contains('inline-choice-content') ||
                        node.classList.contains('seqresponse') ||
                        node.classList.contains('matchedpairs') ||
                        node.classList.contains('ggm') ||
                        node.classList.contains('hotspot') ||
                        node.classList.contains('question-container') ||
                        node.getAttribute('data-ed-tmpl')
                    )) {
                        return true;
                    }
                    node = node.parentElement;
                }
                return false;
            }

            const selectors = [
                'a.player-button.worksheets-next',
                'a.worksheets-next',
                '[id^="section-"] a.worksheets-next',
                '.test-player-nav-next',
                '.test-nav-next',
                '#test-player-next',
                'button[aria-label*="Next"]'
            ];
            for (const d of Ed.Utils.getDocs()) {
                for (const sel of selectors) {
                    const btns = Array.from(d.querySelectorAll(sel));
                    for (const btn of btns) {
                        if (Ed.Utils.isClickable(btn, d) && !isInsideQuestionWidget(btn)) {
                            Ed.UI.showToast('Moving to next question...', 2000);
                            btn.click();
                            return true;
                        }
                    }
                }
            }
            for (const d of Ed.Utils.getDocs()) {
                const candidates = Array.from(d.querySelectorAll('a, button')).filter(el => Ed.Utils.isClickable(el, d) && !isInsideQuestionWidget(el));
                for (const btn of candidates) {
                    const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
                    if (text === 'next' || text === 'next question' || text === 'continue') {
                        Ed.UI.showToast('Moving to next question...', 2000);
                        btn.click();
                        return true;
                    }
                }
            }
            return false;
        },

        clickRetry: () => {
            const selectors = [
                'a.player-button.worksheets-retry',
                'a.worksheets-retry',
                '[class*="worksheets-retry"]',
                '.player-button.worksheets-retry',
                'button.retry-button',
                'button.retry',
                '[aria-label*="Retry"]',
                '[aria-label*="Try Again"]',
                '[aria-label*="Try again"]',
                '.assessment-retry button',
                '.retry button'
            ];
            for (const d of Ed.Utils.getDocs()) {
                for (const sel of selectors) {
                    const btns = Array.from(d.querySelectorAll(sel));
                    for (const btn of btns) {
                        if (Ed.Utils.isVisible(btn, d)) {
                            Ed.UI.showToast('Wrong answer detected — clicking retry', 2000);
                            btn.click();
                            return true;
                        }
                    }
                }

                const candidates = Array.from(d.querySelectorAll('a, button')).filter(el => Ed.Utils.isClickable(el, d));
                for (const btn of candidates) {
                    const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
                    if (text === 'retry' || text === 'try again' || text === 'try another') {
                        Ed.UI.showToast('Wrong answer detected — clicking retry', 2000);
                        btn.click();
                        return true;
                    }
                }
            }
            return false;
        },

        waitAnswerDelay: async (label) => {
            const delayMs = Ed.Config.getAnswerDelay();
            Ed.UI.startCountdownToast(label, Math.ceil(delayMs / 1000));
            await Ed.Utils.delayAsync(delayMs);
            Ed.UI.stopCountdownToast();
        },

        answerTick: async () => {
            if (Ed.State.manuallyPausedSubmission) return;
            if (!Ed.State.answerRunning) return;

            // 1. Check Dialogs
            if (await Ed.Answer.handleSaveExitDialog()) return;

            // 2. Check Retry
            if (Ed.Answer.clickRetry()) {
                Ed.State.lastAnswerWasWrong = true;
                Ed.State.questionRetryCount++;
                if (Ed.State.questionRetryCount >= 3) {
                    Ed.UI.showToast(`Warning: ${Ed.State.questionRetryCount} retries on this question`, 3000);
                }
                await Ed.Utils.delayAsync(2000);
                return;
            }

                        // 3. Check for Final Results Screen & Exit Buttons
            for (const d of Ed.Utils.getDocs()) {
                const returnBtns = Array.from(d.querySelectorAll('button, a'));
                for (const btn of returnBtns) {
                    // CRITICAL: Ignore buttons inside headers/navs to prevent premature exit clicks
                    if (btn.closest('header, nav, .header-wrapper, .top-nav, .global-nav, .rbi-top-nav')) continue;
                    const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
                    // Extremely strict text matching to prevent accidental clicks on the intro screen
                    const isExitBtn = text.includes('close and return') ||
                    text.includes('return to activities');
                    if (isExitBtn) {
                        // STRICT: Only click if we are on the last question and it's answered, or results screen is present
                        const isResultsScreen = !!d.querySelector('.assessment-results, .test-results');
                        if (!isResultsScreen && !Ed.Answer.isOkToExit(d)) continue;
                        // Ensure button is actually visible/clickable on the screen
                        if (btn.offsetWidth > 0 || Ed.Utils.isVisible(btn, d)) {
                            Ed.UI.showToast('Test completed — exiting...', 3000);

                            try { btn.scrollIntoView({ block: 'center' }); } catch(e) {}

                            // Hammer the button with events to ensure Angular catches it
                            btn.click();
                            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

                            Ed.Answer.stopAnswer();
                            await Ed.Utils.delayAsync(1500);
                            return;
                        }
                    }
                }
            }

            // 4. Intro Screens — strictly scoped to actual test player contexts
            const testContexts = ['.test-player-wrapper', '#mastery-test', '.assessment-intro', '.test-intro', '#level-assessment', '.level-assessment-goal'];
            let isInTestPlayer = false;
            for (const d of Ed.Utils.getDocs()) {
                if (testContexts.some(sel => d.querySelector(sel))) { isInTestPlayer = true; break; }
            }

            if (isInTestPlayer) {
                const introSelectors = [
                    '.level-assessment-start',
                    '.level-assessment-goal button',
                    '.mastery-test-start',
                    '.mastery-test-start button',
                    '.mastery-test-goal > div > div > div > button',
                    '.test-player-wrapper .non-item-outer button',
                    '.test-intro button',
                    '.assessment-intro button',
                    '[class*="test-start"] button',
                    'button[aria-label*="Start Test"]',
                    'button[aria-label*="Begin Test"]'
                ];
                for (const d of Ed.Utils.getDocs()) {
                    for (const sel of introSelectors) {
                        const introBtns = Array.from(d.querySelectorAll(sel));
                        for (const introBtn of introBtns) {
                            if (!Ed.Utils.isClickable(introBtn, d)) continue;

                            const btnText = (introBtn.textContent || introBtn.innerText || '').toLowerCase().trim();
                            const aria = (introBtn.getAttribute('aria-label') || '').toLowerCase();
                            const validTexts = ['continue','start','begin','start test','continue test','next'];
                            const isValid = validTexts.some(t => btnText === t || btnText.includes(t) || aria.includes(t));
                            if (!isValid) continue;

                            Ed.UI.showToast('Clicking test continue...', 2000);
                            introBtn.click();
                            await Ed.Utils.delayAsync(1500);
                            return;
                        }
                    }
                }
            }

            let data = null;
            let foundQuestion = false;

            // ===== HOTTEXT =====
            data = Ed.Parsers.extractHottext();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const answered = data.widget.querySelector('.hottext-mc-span[aria-pressed="true"], .hottext-mr-span[aria-pressed="true"]');
                if (answered) {
                    Ed.UI.showToast('Hottext already answered, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing text selection in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing text selection...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let selected;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseMultipleResponseAnswer(text, data.choices));
                    selected = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                if (selected && selected.length > 0) {
                    Ed.UI.showToast(`AI chose ${selected.map(s => s.letter).join(', ')}`, 3000);
                    await Ed.Actions.answerHottext(data, selected);
                    await Ed.Utils.delayAsync(400);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse hottext answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== MCQ =====
            data = Ed.Parsers.extractMCQ();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const answered = data.widget.querySelector('.multichoice input[type="radio"]:checked');
                if (answered) {
                    Ed.UI.showToast('MCQ already answered, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing MCQ in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing MCQ...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let choice;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseAnswer(text, data.choices));
                    choice = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                if (choice) {
                    Ed.UI.showToast(`AI chose ${choice.letter}`, 3000);
                    const input = data.widget.querySelector(`input[data-identifier="${choice.id}"]`);
                    if (input) {
                        input.click();
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        await Ed.Utils.delayAsync(600);
                        await Ed.Answer.clickSubmitOrNext(data.doc);
                        await Ed.Utils.delayAsync(1000);
                    }
                } else {
                    Ed.UI.showToast(`Could not parse AI answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== MULTIPLE RESPONSE =====
            data = Ed.Parsers.extractMultipleResponse();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing multiple-response in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing multiple-response...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let selected;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseMultipleResponseAnswer(text, data.choices));
                    selected = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                if (selected && selected.length > 0) {
                    Ed.UI.showToast(`AI chose ${selected.map(s => s.letter).join(', ')}`, 3000);
                    await Ed.Actions.answerMultipleResponse(data, selected);
                    await Ed.Utils.delayAsync(400);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse MR answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== MatchedPairsSimple =====
            data = Ed.Parsers.extractMatchedPairsSimple();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const droppedCount = data.widget.querySelectorAll('.draggable-item[data-dropped="true"]').length;
                if (droppedCount >= data.droppables.length) {
                    Ed.UI.showToast('Pairs already completed, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing drag-and-drop in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing drag-and-drop...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let mapping;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseGGMAnswer(text, data));
                    mapping = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                const mappedCount = Object.keys(mapping).length;
                if (mappedCount > 0) {
                    Ed.UI.showToast(`AI mapped ${mappedCount} tile(s), placing...`, 3000);
                    await Ed.Actions.answerMPSimple(data, mapping);

                    Ed.UI.showToast('Tiles placed — submitting...', 3000);
                    await Ed.Utils.delayAsync(600);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse pair mapping: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== GGM =====
            data = Ed.Parsers.extractGGM();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const droppedCount = data.widget.querySelectorAll('.draggable-item[data-dropped="true"]').length;
                if (droppedCount >= data.droppables.length) {
                    Ed.UI.showToast('Drag-and-drop already answered, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing drag-and-drop in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing drag-and-drop...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let mapping;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseGGMAnswer(text, data));
                    mapping = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                const mappedCount = Object.keys(mapping).length;
                if (mappedCount > 0) {
                    Ed.UI.showToast(`AI mapped ${mappedCount} tile(s), placing...`, 3000);
                    await Ed.Actions.answerGGM(data, mapping);

                    Ed.UI.showToast('Tiles placed — submitting...', 3000);
                    await Ed.Utils.delayAsync(600);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse GGM mapping: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== MatchedPairsDirected =====
            data = Ed.Parsers.extractMatchedPairs();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const mp = data.widget;
                const droppedCount = mp.querySelectorAll('.droppable.ui-droppable .draggable-item, .droppable.ui-droppable [data-identifier], .draggable-item[data-dropped="true"]').length;
                if (droppedCount >= data.leftItems.length) {
                    Ed.UI.showToast('Matching already complete, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing matching question in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing matching question...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let mapping;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseMatchedPairsAnswer(text, data));
                    mapping = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                const mappedCount = Object.keys(mapping).length;
                if (mappedCount > 0) {
                    Ed.UI.showToast(`AI mapped ${mappedCount} pair(s), placing...`, 3000);
                    await Ed.Actions.answerMatchedPairs(data, mapping);

                    Ed.UI.showToast('Matches placed — submitting...', 3000);
                    await Ed.Utils.delayAsync(800);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse matching answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== TextEntry =====
            data = Ed.Parsers.extractTextEntry();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const allFilled = data.inputs.every(inp => inp.el && inp.el.value.trim() !== '');
                if (allFilled) {
                    Ed.UI.showToast('Text entry already filled, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing text entry in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing text entry...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let values;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseTextEntryAnswer(text, data));
                    values = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                const filledCount = Object.values(values).filter(v => v !== '').length;
                if (filledCount > 0) {
                    Ed.UI.showToast(`AI answered ${filledCount} box(es)`, 3000);
                    await Ed.Actions.answerTextEntry(data, values);

                    Ed.UI.showToast('Boxes filled — submitting...', 3000);
                    await Ed.Utils.delayAsync(600);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse text entry answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== SeqResponse =====
            data = Ed.Parsers.extractSeqResponse();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const droppedCount = data.widget.querySelectorAll('.draggable-item[data-dropped="true"]').length;
                if (droppedCount >= data.droppables.length) {
                    Ed.UI.showToast('Sequence already completed, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing sequence question in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing sequence question...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let mapping;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseSeqResponseAnswer(text, data));
                    mapping = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                const mappedCount = Object.keys(mapping).length;
                if (mappedCount > 0) {
                    Ed.UI.showToast(`AI mapped ${mappedCount} tile(s), placing...`, 3000);
                    await Ed.Actions.answerSeqResponse(data, mapping);

                    Ed.UI.showToast('Sequence placed — submitting...', 3000);
                    await Ed.Utils.delayAsync(600);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse sequence answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== InlineChoice =====
            data = Ed.Parsers.extractInlineChoice();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const allSelected = data.menus.every(menu => {
                    const select = menu.el || data.widget.querySelector(`select#${menu.id}`);
                    return select && select.value !== '';
                });
                if (allSelected) {
                    Ed.UI.showToast('Inline choice already answered, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing inline choice in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing inline choice...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let mapping;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseInlineChoiceAnswer(text, data));
                    mapping = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                const filledCount = Object.values(mapping).filter(v => v !== undefined && v !== '').length;
                if (filledCount > 0) {
                    Ed.UI.showToast(`AI chose ${filledCount} menu(s)`, 3000);
                    await Ed.Actions.answerInlineChoice(data, mapping);

                    Ed.UI.showToast('Menus filled — submitting...', 3000);
                    await Ed.Utils.delayAsync(600);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse inline choice answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // ===== Hotspot =====
            data = Ed.Parsers.extractHotspot();
            if (data) {
                foundQuestion = true;
                const sig = Ed.Parsers.getQuestionSignature(data);
                if (sig !== Ed.State.lastQuestionSignature) {
                    Ed.State.lastQuestionSignature = sig;
                    Ed.State.lastAnswerWasWrong = false;
                    Ed.State.lastAnswerRaw = null;
                    Ed.State.questionRetryCount = 0;
                    Ed.State.hasConfirmedSubmission = false;
                }

                const selected = data.widget.querySelector('.clickable[aria-pressed="true"]');
                if (selected) {
                    Ed.UI.showToast('Hotspot already selected, submitting...', 2000);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                    return;
                }

                await Ed.Answer.waitAnswerDelay('Analyzing hotspot in');
                if (!Ed.State.answerRunning || Ed.State.manuallyPausedSubmission) return;

                Ed.UI.showToast('Analyzing hotspot...', 2000);
                if (Ed.State.lastAnswerWasWrong && Ed.State.lastAnswerRaw) {
                    data.previousWrong = Ed.State.lastAnswerRaw;
                }

                let hotspot;
                try {
                    const { result, parsed } = await Ed.AI.fetchAIAnswer(data, (text) => Ed.Parsers.parseHotspotAnswer(text, data));
                    hotspot = parsed;
                    Ed.State.lastAnswerRaw = result.answer;
                } catch (e) {
                    if (e.message === 'STOPPED') { Ed.UI.showToast('AutoAnswer halted', 2000); return; }
                    Ed.UI.showToast(`AI error: ${e.message}`, 3000);
                    return;
                }

                if (hotspot) {
                    Ed.UI.showToast(`AI chose ${hotspot.label}`, 3000);
                    await Ed.Actions.answerHotspot(data, hotspot);

                    Ed.UI.showToast('Hotspot selected — submitting...', 3000);
                    await Ed.Utils.delayAsync(600);
                    await Ed.Answer.clickSubmitOrNext(data.doc);
                    await Ed.Utils.delayAsync(1000);
                } else {
                    Ed.UI.showToast(`Could not parse hotspot answer: "${Ed.State.lastAnswerRaw}"`, 3000);
                }
                return;
            }

            // 5. IF NO QUESTION FOUND, TRY NEXT BUTTON
            if (!foundQuestion && Ed.Answer.clickNextQuestion()) {
                Ed.State.lastAnswerWasWrong = false;
                Ed.State.lastAnswerRaw = null;
                Ed.State.lastQuestionSignature = null;
                Ed.State.questionRetryCount = 0;
                Ed.State.hasConfirmedSubmission = false;
                await Ed.Utils.delayAsync(1500);
                return;
            }

            // 6. IF NO NEXT BUTTON, Check for End Session / Submit Test
            const endSessionSelectors = [
                '[id^="section-"] a.player-button.worksheets-endsession',
                'a.player-button.worksheets-endsession.improved-contrast',
                '.buttons-container.readable a.player-button.worksheets-endsession',
                'button.worksheets-endsession',
                'a.worksheets-endsession',
                'button[aria-label*="Submit Test"]'
            ];
            for (const d of Ed.Utils.getDocs()) {
                for (const sel of endSessionSelectors) {
                    const endBtns = Array.from(d.querySelectorAll(sel));
                    for (const btn of endBtns) {
                        if (Ed.Utils.isClickable(btn, d)) {
                            // Ensure the final question is answered before ending the session
                            if (!Ed.Answer.isOkToExit(d)) continue;

                            if (Ed.Config.get('CONFIRM_SUBMIT', false) && !Ed.State.hasConfirmedSubmission) {
                                Ed.Utils.setStatus('AWAITING_MANUAL');
                                const confirmed = await Ed.Nav.showConfirmModal();
                                if (!confirmed) {
                                    Ed.Utils.setStatus('IDLE');
                                    return;
                                }
                                Ed.State.hasConfirmedSubmission = true;
                                Ed.Utils.setStatus('SOLVING');
                            }
                            Ed.UI.showToast('End session button found — continuing...', 2000);
                            btn.click();
                            await Ed.Utils.delayAsync(1500);
                            return;
                        }
                    }
                }
            }
        },

        startAnswer: (silent = false) => {
            if (window.self !== window.top) return;
            const keys = { cerebras: Ed.Config.safeGetKey('cerebras_key') };
            if (!keys.cerebras) {
                if (!silent) Ed.UI.showToast('Please set your Cerebras API key first', 3000);
                return;
            }
            Ed.State.answerRunning = true;
            Ed.Utils.setStatus('SOLVING');
            Ed.Config.set('AUTO_ANSWER_ENABLED', true);
            Ed.UI.updateToggle('AUTO_ANSWER_ENABLED', true);

            if (!silent) Ed.UI.showToast('AutoAnswer started', 2000);

            if (!Ed.State.answerIv) {
                Ed.State.answerIv = setInterval(async () => {
                    if (Ed.State.answerBusy || !Ed.State.answerRunning) return;
                    if (Ed.Tutorial.isTutorialActive() && !Ed.Tutorial.isTutorialCompletedScreen()) return;
                    Ed.State.answerBusy = true;
                    try {
                        await Ed.Answer.answerTick();
                    } catch(e) {
                        Ed.Utils.log.error('answerTick error:', e);
                    }
                    Ed.State.answerBusy = false;
                }, 2000);
            }
        },

        stopAnswer: () => {
            Ed.State.answerRunning = false;
            Ed.Config.set('AUTO_ANSWER_ENABLED', false);
            Ed.UI.updateToggle('AUTO_ANSWER_ENABLED', false);
            if (Ed.State.answerIv) { clearInterval(Ed.State.answerIv); Ed.State.answerIv = null; }
            Ed.State.answerBusy = false;
            Ed.UI.stopCountdownToast();
            Ed.Utils.setStatus('IDLE');
        }
    };

    // ========================================================================
    // AUTO TUTORIAL
    // ========================================================================
    Ed.Tutorial = {
        isTutorialActive: () => {
            for (const d of Ed.Utils.getDocs()) {
                if (d.querySelector('.tutorial-toc-sections')) return true;
                if (d.querySelector('.tutorial-viewport-footer-content')) return true;
                if (d.querySelector('.tutorial-nav-progress-current')) return true;
                const nav = d.querySelector('.tutorial-nav');
                const footer = d.querySelector('.tutorial-viewport-footer-content');
                if (nav && footer) return true;
            }
            return false;
        },

        isTutorialCompletedScreen: () => {
            for (const d of Ed.Utils.getDocs()) {
                const titles = d.querySelectorAll('.global-title, h2, h1');
                for (const t of titles) {
                    if (t.textContent.includes('Congratulations')) {
                        const content = d.body.textContent || '';
                        if (content.includes('You have completed the tutorial')) {
                            return true;
                        }
                    }
                }
            }
            return false;
        },

        getTocButtons: (toc) => Array.from(toc.children).map(c => c.querySelector('button')).filter(Boolean),

        enableTocButtons: (toc) => {
            const btns = Ed.Tutorial.getTocButtons(toc);
            btns.forEach(b => {
                if (b.className.includes('toc-current')) return;
                b.className = 'toc-section toc-visited';
                b.removeAttribute('disabled');
                b.removeAttribute('aria-disabled');
            });
            return btns;
        },

        getProgress: () => {
            const c = Ed.Utils.$('.tutorial-nav-progress-current');
            const t = Ed.Utils.$('.tutorial-nav-progress-total');
            return c && t ? { cur: parseInt(c.el.textContent) || 0, tot: parseInt(t.el.textContent) || 0 } : null;
        },

        clickNext: () => {
            const b = Ed.Utils.$('.tutorial-nav-next');
            if (!b) return false;
            const el = b.el;
            el.removeAttribute('disabled');
            el.removeAttribute('ng-disabled');
            el.classList.remove('disabled');
            el.style.pointerEvents = 'auto';
            el.click();
            return true;
        },

        clickExit: () => {
            for (const d of Ed.Utils.getDocs()) {
                const el = d.querySelector('button.tutorial-nav-exit, button[aria-label*="Save & Exit"], body > div.wrapper > div.header-wrapper > header > div > nav > button.tutorial-nav-exit');
                if (el && el.offsetWidth > 0) {
                    el.click();
                    return true;
                }
            }
            const b = Ed.Utils.$('.tutorial-nav-exit');
            if (b && Ed.Utils.isClickable(b.el, b.doc)) {
                b.el.click();
                return true;
            }
            return false;
        },

        stopTutorialExecution: () => {
            Ed.State.tutorialRunning = false;
            Ed.State.tutorialInitialDelayMet = false;
            Ed.State.autoTos.forEach(clearTimeout);
            Ed.State.autoTos = [];
            Ed.UI.stopCountdownToast();
            Ed.Utils.setStatus('IDLE');
        },

        disableTutorialMode: () => {
            Ed.Config.set('AUTO_TUTORIAL_ENABLED', false);
            Ed.UI.updateToggle('AUTO_TUTORIAL_ENABLED', false);
            Ed.Tutorial.stopTutorialExecution();
            Ed.UI.showToast('AutoTutorial disabled', 2000);
        },

        finishTutorial: () => {
            Ed.Tutorial.stopTutorialExecution();

            if (Ed.Tutorial.clickExit()) {
                Ed.UI.showToast('Tutorial saved & exited', 3000);
                return;
            }

            Ed.UI.showToast('Tutorial complete', 3000);

            let attempts = 0;
            const iv = setInterval(() => {
                attempts++;
                if (Ed.Tutorial.clickExit()) {
                    clearInterval(iv);
                    Ed.UI.showToast('Tutorial saved & exited', 3000);
                    return;
                }
                if (attempts > 10) {
                    clearInterval(iv);
                    Ed.UI.showToast('Exit manually if needed', 3000);
                }
            }, 1000);
            Ed.State.autoTos.push(iv);
        },

        isTutorialDone: (toc) => {
            const btns = Ed.Tutorial.getTocButtons(toc);
            return btns.length > 0 && btns.every(b => b.className.includes('toc-visited'));
        },

        waitForVisited: (btn, maxMs = 15000) => {
            return new Promise(resolve => {
                if (btn.className.includes('toc-visited')) return resolve();
                const observer = new MutationObserver(() => {
                    if (!btn.isConnected || btn.className.includes('toc-visited') || !Ed.State.tutorialRunning) {
                        observer.disconnect();
                        resolve();
                    }
                });
                if (btn.isConnected) observer.observe(btn, { attributes: true, attributeFilter: ['class'] });
                setTimeout(() => { observer.disconnect(); resolve(); }, maxMs);
            });
        },

        runSequential: async (toc) => {
            while (Ed.State.tutorialRunning) {
                Ed.Answer.handleSaveExitDialog();
                if (Ed.Tutorial.isTutorialCompletedScreen()) break;

                Ed.Tutorial.enableTocButtons(toc);
                const btns = Ed.Tutorial.getTocButtons(toc);

                // Attempt to jump to the end during the loop
                if (btns.length > 0) {
                    const lastBtn = btns[btns.length - 1];
                    if (!lastBtn.className.includes('toc-visited') && !lastBtn.className.includes('toc-current')) {
                        lastBtn.click();
                        await Ed.Utils.delayAsync(150);
                    }
                }

                const next = btns.find(b => !b.className.includes('toc-visited'));
                if (!next) {
                    const p = Ed.Tutorial.getProgress();
                    if (!Ed.Tutorial.isTutorialCompletedScreen() && (!p || p.cur < p.tot)) {
                        Ed.Tutorial.clickNext();
                        await Ed.Utils.delayAsync(600);
                        continue;
                    }
                    break;
                }

                if (next.className.includes('toc-current')) {
                    await Ed.Tutorial.waitForVisited(next);
                    continue;
                }

                await Ed.Utils.delayAsync(100); // blazing fast after initial delay
                if (!Ed.State.tutorialRunning) break;

                next.click();
                await Ed.Tutorial.waitForVisited(next);
            }
            if (Ed.State.tutorialRunning) Ed.Tutorial.finishTutorial();
        },

        runTutorialSequential: async () => {
            let stallCount = 0;
            let lastCur = -1;
            while (Ed.State.tutorialRunning) {
                Ed.Answer.handleSaveExitDialog();
                if (Ed.Tutorial.isTutorialCompletedScreen()) break;

                const p = Ed.Tutorial.getProgress();
                if (!p || p.cur >= p.tot) {
                    break;
                }

                if (p.cur === lastCur) {
                    stallCount++;
                    if (stallCount > 20) {
                        break;
                    }
                } else {
                    stallCount = 0;
                    lastCur = p.cur;
                }

                await Ed.Utils.delayAsync(100); // blazing fast
                if (!Ed.State.tutorialRunning) break;

                // Attempt to jump to the end during the loop
                const tocNode = Ed.Utils.$('.tutorial-toc-sections');
                if (tocNode) {
                    const tocBtns = Ed.Tutorial.enableTocButtons(tocNode.el);
                    if (tocBtns.length > 0) {
                        const lastBtn = tocBtns[tocBtns.length - 1];
                        if (!lastBtn.className.includes('toc-visited') && !lastBtn.className.includes('toc-current')) {
                            lastBtn.click();
                        }
                    }
                }

                let nextClicked = false;
                for (let i = 0; i < 3; i++) {
                    if (Ed.Tutorial.clickNext()) {
                        nextClicked = true;
                        break;
                    }
                    await Ed.Utils.delayAsync(100);
                }

                if (nextClicked) {
                    await Ed.Utils.delayAsync(200);
                } else {
                    await Ed.Utils.delayAsync(500);
                }
            }
            if (Ed.State.tutorialRunning) Ed.Tutorial.finishTutorial();
            return false;
        },

        execTutorial: async (tocEl) => {
            if (Ed.State.tutorialRunning && Ed.State.tutorialBusy) return;
            Ed.State.tutorialRunning = true;
            Ed.State.tutorialBusy = true;
            Ed.Utils.setStatus('ADVANCING');
            Ed.UI.showToast('AutoTutorial started', 2000);

            if (!Ed.State.tutorialInitialDelayMet) {
                const delayMs = Ed.Config.getTutorialDelay();
                Ed.UI.startCountdownToast("Completing tutorial in", Math.ceil(delayMs / 1000));
                await Ed.Utils.delayAsync(delayMs);
                Ed.UI.stopCountdownToast();
                if (!Ed.State.tutorialRunning) {
                    Ed.State.tutorialBusy = false;
                    return;
                }
                Ed.State.tutorialInitialDelayMet = true;
            }

            if (Ed.Tutorial.isTutorialCompletedScreen()) {
                Ed.Tutorial.finishTutorial();
                Ed.State.tutorialBusy = false;
                return;
            }

            const btns = Ed.Tutorial.enableTocButtons(tocEl);
            if (btns.length === 0) {
                await Ed.Tutorial.runTutorialSequential();
                Ed.State.tutorialBusy = false;
                return;
            }

            if (Ed.Tutorial.isTutorialDone(tocEl)) { Ed.Tutorial.finishTutorial(); Ed.State.tutorialBusy = false; return; }

            const progress = Ed.Tutorial.getProgress();
            if (progress && progress.tot > 0) {
                const remaining = progress.tot - progress.cur;
                if (remaining > 0 && remaining <= 5) {
                    Ed.UI.showToast(`Finishing last ${remaining} slides...`, 3000);
                    await Ed.Tutorial.runTutorialSequential();
                    Ed.State.tutorialBusy = false;
                    return;
                }
            }

            const last = btns[btns.length - 1];
            last.click();
            Ed.UI.showToast('Skipping to end...', 2000);

            await Ed.Utils.delayAsync(500);
            let jumped = false;
            for (let i = 0; i < 10; i++) {
                if (!Ed.State.tutorialRunning) { Ed.State.tutorialBusy = false; return; }
                if (last.className.includes('toc-current') || last.className.includes('toc-visited')) {
                    jumped = true;
                    break;
                }
                await Ed.Utils.delayAsync(300);
            }

            if (jumped && Ed.Tutorial.isTutorialDone(tocEl)) {
                const p = Ed.Tutorial.getProgress();
                const trulyDone = Ed.Tutorial.isTutorialCompletedScreen() || (p && p.cur >= p.tot);
                if (trulyDone) {
                    Ed.Tutorial.finishTutorial();
                    Ed.State.tutorialBusy = false;
                    return;
                }
                Ed.UI.showToast('Almost done — finishing remaining slides...', 2000);
            }

            if (jumped) {
                Ed.UI.showToast('Finishing last sections...', 2000);
            } else {
                Ed.UI.showToast('Skip failed, running sequentially...', 3000);
            }

            const postJumpProgress = Ed.Tutorial.getProgress();
            if (postJumpProgress && postJumpProgress.tot > 0) {
                const remaining = postJumpProgress.tot - postJumpProgress.cur;
                if (remaining > 0 && remaining <= 5) {
                    await Ed.Tutorial.runTutorialSequential();
                    Ed.State.tutorialBusy = false;
                    return;
                }
            }

            await Ed.Tutorial.runSequential(tocEl);
            Ed.State.tutorialBusy = false;
        },

        simpleTutorialNavLoop: async (doc) => {
            if (!Ed.State.tutorialRunning) return;
            let attempts = 0;
            while (Ed.State.tutorialRunning && attempts < 150) {
                Ed.State.lastActivityTime = Date.now();
                if (!Ed.State.tutorialRunning) return;

                Ed.Answer.handleSaveExitDialog();

                if (Ed.Tutorial.isTutorialCompletedScreen()) {
                    Ed.Tutorial.finishTutorial();
                    return;
                }

                const toc = doc.querySelector('.tutorial-toc-sections');
                if (toc) {
                    await Ed.Tutorial.execTutorial(toc);
                    return;
                }

                if (!Ed.State.tutorialInitialDelayMet) {
                    const delayMs = Ed.Config.getTutorialDelay();
                    Ed.UI.startCountdownToast("Completing tutorial in", Math.ceil(delayMs / 1000));
                    await Ed.Utils.delayAsync(delayMs);
                    Ed.UI.stopCountdownToast();
                    if (!Ed.State.tutorialRunning) break;
                    Ed.State.tutorialInitialDelayMet = true;
                } else {
                    await Ed.Utils.delayAsync(100);
                }

                let nextOk = false;
                for (let i = 0; i < 3; i++) {
                    if (Ed.Tutorial.clickNext()) { nextOk = true; break; }
                    await Ed.Utils.delayAsync(100);
                }

                if (!nextOk) {
                    const p = Ed.Tutorial.getProgress();
                    if (p && p.cur >= p.tot) {
                        if (Ed.Tutorial.clickExit()) {
                            Ed.Tutorial.stopTutorialExecution();
                            Ed.UI.showToast('Tutorial exited', 3000);
                            return;
                        }
                    }
                }
                attempts++;
                await Ed.Utils.delayAsync(200);
            }
            if (attempts >= 150) {
                Ed.Tutorial.clickExit();
                Ed.Tutorial.stopTutorialExecution();
            }
        },

        tryStartTutorial: async () => {
            if (window.self !== window.top) return;
            if (!Ed.Config.get('AUTO_TUTORIAL_ENABLED', false) || Ed.State.tutorialRunning) return;

            Ed.State.tutorialInitialDelayMet = false;

            if (Ed.Tutorial.isTutorialCompletedScreen()) {
                Ed.Tutorial.finishTutorial();
                return;
            }

            const toc = Ed.Utils.$('.tutorial-toc-sections');
            if (toc) {
                Ed.UI.showToast('Tutorial detected, starting...', 2000);
                await Ed.Tutorial.execTutorial(toc.el);
                return;
            }
            for (const d of Ed.Utils.getDocs()) {
                const hasToc = d.querySelector('.tutorial-toc-sections');
                const hasNav = d.querySelector('.tutorial-nav-next, .tutorial-nav-exit');
                const hasProgress = d.querySelector('.tutorial-nav-progress-current');
                if ((hasToc || hasNav || hasProgress) && !Ed.State.tutorialRunning) {
                    Ed.UI.showToast('Tutorial detected, starting...', 2000);
                    if (hasToc) {
                        await Ed.Tutorial.execTutorial(hasToc);
                    } else {
                        Ed.State.tutorialRunning = true;
                        Ed.Utils.setStatus('ADVANCING');
                        await Ed.Tutorial.simpleTutorialNavLoop(d);
                    }
                    return;
                }
            }
        }
    };

    // ========================================================================
    // AUTO ACTIVITY
    // ========================================================================
    Ed.Nav = {
        autoNavigate: () => {
            const autoActivity = Ed.Config.get('AUTO_ACTIVITY_ENABLED', false);
            const autoAdvance = Ed.Config.get('AUTO_ADVANCE_ENABLED', false);
            if (!autoActivity && !autoAdvance) return;
            if (Ed.State.isNavigating) return;

            const wrappers = document.querySelectorAll('.activity-wrapper');
            if (!wrappers.length) return;

            let tutorialBtn = null;
            let practiceBtn = null;
            let masteryBtn = null;
            let genericBtn = null;
            let foundLocked = false;
            let hasUnfinished = false;

            for (const wrapper of wrappers) {
                const nameEl = wrapper.querySelector('.activity-name');
                const progressEl = wrapper.querySelector('.activity-progress');
                if (!nameEl || !progressEl) continue;

                const name = nameEl.textContent || '';
                const status = progressEl.textContent || '';
                const html = wrapper.innerHTML;

                const isFullyDone = (status.includes('Completed') && !status.includes('Not Mastered')) || html.includes('status-circle-complete') || html.includes('status-circle-mastered') || !!wrapper.querySelector('[class*="complete"]:not([class*="not-complete"])');
                const isLocked = html.includes('locked-tag') || status.includes('Locked') || !!wrapper.querySelector('.locked, [class*="locked"], [aria-disabled="true"]');

                if (isFullyDone) continue;
                if (isLocked) { foundLocked = true; continue; }

                // If it is not done and not locked, we have active unfinished coursework
                hasUnfinished = true;

                const playBtn = wrapper.querySelector('a[lrn-button], a.hover-pop, button.activity-button');
                if (!playBtn) continue;

                const isTutorial = name.includes('Tutorial');
                const isPractice = name.includes('Practice');
                const isMastery = name.includes('Mastery Test') || name.includes('Mastery');
                const isPostTest = name.includes('Post Test') || name.includes('Unit Post') || name.includes('Unit Test');
                const isQuiz = name.includes('Quiz') || (name.includes('Test') && !isTutorial && !isPractice);
                const isGeneric = !isTutorial && !isPractice && !isMastery && !isPostTest && !isQuiz;

                if (isTutorial && !tutorialBtn) {
                    tutorialBtn = playBtn;
                } else if (isPractice && !practiceBtn) {
                    practiceBtn = playBtn;
                } else if ((isMastery || isPostTest || isQuiz) && !masteryBtn) {
                    masteryBtn = playBtn;
                } else if (isGeneric && !genericBtn) {
                    genericBtn = playBtn;
                }
            }

            // Only attempt to enter active lessons if they are unfinished
            if (hasUnfinished) {
                if (autoActivity) {
                    if (tutorialBtn) {
                        Ed.State.isNavigating = true;
                        Ed.UI.showToast('Entering tutorial...', 2000);
                        tutorialBtn.click();
                        setTimeout(() => { Ed.State.isNavigating = false; }, 5000);
                    } else if (practiceBtn) {
                        Ed.State.isNavigating = true;
                        Ed.UI.showToast('Entering practice...', 2000);
                        practiceBtn.click();
                        setTimeout(() => { Ed.State.isNavigating = false; }, 5000);
                    } else if (masteryBtn) {
                        Ed.State.isNavigating = true;
                        Ed.UI.showToast('Entering mastery test...', 2000);
                        masteryBtn.click();
                        setTimeout(() => { Ed.State.isNavigating = false; }, 5000);
                    } else if (genericBtn) {
                        Ed.State.isNavigating = true;
                        Ed.UI.showToast('Entering activity...', 2000);
                        genericBtn.click();
                        setTimeout(() => { Ed.State.isNavigating = false; }, 5000);
                    }
                }
            } else {
                // If there are no unfinished, unlocked lessons, it is safe to advance to the next activity
                const nextActivityBtn = document.querySelector('lrn-launch-pad-nav a.right, a[aria-label*="Navigate to next activity"], a.right[href*="launchpad"]');

                if (nextActivityBtn && Ed.Utils.isClickable(nextActivityBtn, document)) {
                    if (autoAdvance) {
                        Ed.State.isNavigating = true;
                        Ed.UI.showToast('Activity complete — moving to next...', 2000);

                        nextActivityBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        nextActivityBtn.click();

                        const nextUrl = nextActivityBtn.href || nextActivityBtn.getAttribute('href');
                        if (nextUrl) {
                            setTimeout(() => {
                                window.location.href = nextUrl;
                            }, 500);
                        }
                        setTimeout(() => { Ed.State.isNavigating = false; }, 5000);
                    } else {
                        Ed.UI.showToast('Activity complete. AutoAdvance disabled.', 3000);
                    }
                } else if (foundLocked) {
                    Ed.UI.showToast('Next activity is locked...', 2000);
                } else {
                    Ed.UI.showToast('All activities complete', 3000);
                }
            }
        },

        showConfirmModal: () => {
            return new Promise((resolve) => {
                if (document.getElementById('ed-confirm-modal')) {
                    return new Promise(res => {
                        document.addEventListener('ed-modal-closed', () => Ed.Nav.showConfirmModal().then(resolve).then(res), { once: true });
                    });
                }
                Ed.UI.injectGlobalModalStyles();

                if (Ed.Config.get("AUTO_NOTIFY", true)) {
                    Ed.Notifications.send("Edmentum Solver", { body: "Ready to submit! Waiting for your confirmation.", requireInteraction: true });
                }

                const overlay = document.createElement('div');
                overlay.id = 'ed-confirm-modal';
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');
                overlay.innerHTML = `
                    <div class="ed-confirm-box">
                        <div class="ed-confirm-title">⚠️ Ready to Submit</div>
                        <div class="ed-confirm-text">The script has completed the assignment/quiz and is ready to submit. Do you want to review your answers or submit now?</div>
                        <div class="ed-confirm-btns">
                            <button class="ed-btn-yes" id="ed-btn-submit-now">Submit Now</button>
                            <button class="ed-btn-no" id="ed-btn-review">Review First</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(overlay);

                const btnSubmit = document.getElementById('ed-btn-submit-now');
                const btnReview = document.getElementById('ed-btn-review');
                btnSubmit.focus();

                const handleClose = (result) => {
                    overlay.remove();
                    document.dispatchEvent(new CustomEvent('ed-modal-closed'));
                    resolve(result);
                };

                btnSubmit.addEventListener('click', () => handleClose(true));

                btnReview.addEventListener('click', () => {
                    Ed.State.manuallyPausedSubmission = true;
                    Ed.UI.updateResumeButton();
                    handleClose(false);
                });
            });
        }
    };

    // ========================================================================
    // UI & MODALS
    // ========================================================================
    Ed.UI = {
        toastStylesInjected: false,
        panelElement: null,

        toggleAutoHide: (enable) => {
            let style = document.getElementById('ed-autohide-style');
            if (enable) {
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'ed-autohide-style';
                    style.textContent = `[fxlayout="row"]:has(> lrn-svg-image[name="student-avatar"]) { display: none !important; } .user-names, .user-date, lrn-svg-image[name="student-avatar"] { display: none !important; }`;
                    document.head.appendChild(style);
                }
            } else {
                if (style) style.remove();
            }
        },

        injectGlobalModalStyles: () => {
            if (document.getElementById('ed-global-modal-styles')) return;
            const style = document.createElement('style');
            style.id = 'ed-global-modal-styles';
            style.textContent = `
                #ed-setup-modal, #ed-recom-modal, #ed-notif-modal, #ed-confirm-modal, #ed-bg-alert-modal, #ed-applied-modal, #ed-invalid-key-modal { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.8); backdrop-filter: blur(10px); display: flex; justify-content: center; align-items: center; z-index: 100000000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
                .modal-box { background: #0f172a; width: 480px; padding: 35px; border-radius: 24px; box-shadow: 0 30px 80px rgba(0,0,0,0.8); border: 1px solid rgba(255,255,255,0.05); transform: translateY(20px); opacity: 0; animation: slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
                @keyframes slideUp { to { transform: translateY(0); opacity: 1; } }
                @keyframes slideDown { to { transform: translateY(20px); opacity: 0; } }
                @keyframes fadeOut { to { opacity: 0; } }
                .modal-title { color: #f8fafc; font-size: 24px; font-weight: 700; margin-bottom: 10px; display:flex; align-items:center; gap:12px; letter-spacing: -0.5px; }
                .modal-title span { background: linear-gradient(135deg, #10b981, #3b82f6); padding: 6px 12px; border-radius: 10px; font-size:18px; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
                .modal-desc { color: #94a3b8; font-size: 13px; margin-bottom: 25px; line-height: 1.5; }
                .input-group { margin-bottom: 20px; }
                .input-group label { display: block; color: #cbd5e1; font-size: 13px; margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;}
                .input-group input, .input-group select { width: 100%; padding: 14px; background: #1e293b; border: 1px solid #334155; color: #f8fafc; border-radius: 12px; box-sizing: border-box; outline: none; transition: border 0.3s, box-shadow 0.3s; font-family: monospace; font-size: 14px;}
                .input-group input:focus, .input-group select:focus { border-color: #10b981; box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2); }
                .input-group .key-error { color: #ef4444; font-size: 11px; margin-top: 6px; display: none; }
                .input-group .key-error.show { display: block; }
                .input-group .key-validating { color: #10b981; font-size: 11px; margin-top: 6px; display: none; }
                .input-group .key-validating.show { display: block; }
                .save-btn { width: 100%; padding: 16px; background: linear-gradient(135deg, #10b981, #059669); color: #fff; border: none; border-radius: 14px; font-weight: 700; font-size: 15px; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; box-shadow: 0 8px 25px rgba(16, 185, 129, 0.4); margin-top: 10px; }
                .save-btn:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(16, 185, 129, 0.5); }
                .save-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
                .btn-secondary { background: #475569; box-shadow: none; }
                .btn-secondary:hover { background: #334155; transform: translateY(-2px); }
                .btn-row { display: flex; gap: 15px; margin-top: 10px; }
                .ed-confirm-box { background:#1e293b; padding:30px; border-radius:16px; border:1px solid #334155; text-align:center; color:#f8fafc; max-width:400px; box-shadow:0 20px 50px rgba(0,0,0,0.5); }
                .ed-confirm-title { font-size:20px; font-weight:bold; margin-bottom:15px; display:flex; align-items:center; justify-content:center; gap:10px; color:#10b981;}
                .ed-confirm-text { color:#cbd5e1; margin-bottom:25px; line-height:1.6; font-size:14px; }
                .ed-confirm-btns { display:flex; gap:15px; justify-content:center; }
                .ed-btn-yes { background:#10b981; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-weight:bold; transition:background 0.2s; font-size:14px;}
                .ed-btn-yes:hover { background:#059669; }
                .ed-btn-no { background:#475569; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-weight:bold; transition:background 0.2s; font-size:14px;}
                .ed-btn-no:hover { background:#334155; }
            `;
            document.head.appendChild(style);
        },

        showToast: (text, duration = 2500) => {
            Ed.State.lastActivityTime = Date.now();
            if (!Ed.Config.get("TOAST_ENABLED", true) || !document.body) return;
            if (!Ed.UI.toastStylesInjected) {
                Ed.UI.toastStylesInjected = true;
                const style = document.createElement('style'); style.id = 'ed-toast-styles';
                style.textContent = `
                    #ed-toast { position: fixed; bottom: -60px; left: 50%; transform: translateX(-50%); background: rgba(15, 23, 42, 0.95); color: #fff; padding: 10px 20px; border-radius: 30px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; display: flex; align-items: center; gap: 10px; z-index: 99999999; box-shadow: 0 8px 32px rgba(0,0,0,0.4); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); opacity: 0; transition: bottom 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); pointer-events: none; white-space: nowrap; max-width: 90vw; }
                    #ed-toast.show { bottom: 25px; opacity: 1; }
                    .ed-toast-icon { background: linear-gradient(135deg, #10b981, #3b82f6); color: white; width: 22px; height: 22px; border-radius: 50%; display: flex; justify-content: center; align-items: center; font-weight: bold; font-size: 12px; flex-shrink: 0; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4); }
                `;
                (document.head || document.documentElement).appendChild(style);
            }
            let toast = document.getElementById('ed-toast');
            if (!toast) { toast = document.createElement('div'); toast.id = 'ed-toast'; document.body.appendChild(toast); }
            toast.innerHTML = `<div class="ed-toast-icon">E</div>`;
            const span = document.createElement('span'); span.textContent = text; toast.appendChild(span);
            toast.offsetHeight; toast.classList.add('show');
            if (toast.timeoutId) clearTimeout(toast.timeoutId);
            toast.timeoutId = setTimeout(() => toast.classList.remove('show'), duration);
        },

        startCountdownToast: (baseText, seconds) => {
            Ed.State.lastActivityTime = Date.now();
            Ed.UI.stopCountdownToast();
            const id = ++Ed.State.currentCountdownId; let count = seconds;
            const update = () => {
                if (id !== Ed.State.currentCountdownId) return;
                if (count <= 0) { Ed.UI.stopCountdownToast(); return; }
                Ed.UI.showToast(`${baseText} ${count}s...`, 1200); count--;
            };
            update(); Ed.State.countdownInterval = setInterval(update, 1000);
        },

        stopCountdownToast: () => {
            if (Ed.State.countdownInterval) { clearInterval(Ed.State.countdownInterval); Ed.State.countdownInterval = null; }
            Ed.State.currentCountdownId++;
        },

        updateSolvingIndicator: (isActive) => {
            if (!Ed.UI.panelElement) return;
            if (isActive) Ed.UI.panelElement.classList.add('solving');
            else Ed.UI.panelElement.classList.remove('solving');
        },

        updateResumeButton: () => {
            const btn = document.getElementById('ed-resume-btn');
            if (btn) {
                const shouldShow = Ed.State.manuallyPausedSubmission && Ed.State.status === 'IDLE';
                btn.style.display = shouldShow ? 'block' : 'none';
            }
        },

        closeModalSmoothly: (overlay, resolve) => {
            overlay.style.animation = 'fadeOut 0.4s ease forwards';
            overlay.querySelector('.modal-box').style.animation = 'slideDown 0.4s ease forwards';
            setTimeout(() => { overlay.remove(); document.dispatchEvent(new CustomEvent('ed-modal-closed')); resolve(); }, 400);
        },

        showSetupModal: () => {
            return new Promise((resolve) => {
                if (window.self !== window.top || document.getElementById('ed-setup-modal')) return resolve();
                Ed.UI.injectGlobalModalStyles();
                const overlay = document.createElement('div'); overlay.id = 'ed-setup-modal';
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');
                overlay.innerHTML = `
                    <div class="modal-box">
                        <div class="modal-title"><span>E</span> Edmentum Solver Setup</div>
                        <div class="modal-desc">
                        <strong style="color:#f8fafc;">Cerebras:</strong> Go to <a href="https://www.cerebras.ai/ " target="_blank" style="color:#10b981; text-decoration:none;">cerebras.ai</a>, login until you see your API key. Pick the <strong>free subscription</strong>. Copy and input it below.<br><br>
                        </div>
                        <div class="input-group">
                            <label>Cerebras API Key</label>
                            <input type="password" id="ed-cerebras-key" placeholder="sk-...">
                            <div class="key-error" id="cerebras-key-error">❌ Invalid API Key</div>
                            <div class="key-validating" id="cerebras-key-validating">⏳ Validating...</div>
                        </div>
                        <button class="save-btn" id="ed-save-keys">Save & Continue</button>
                    </div>`;
                document.body.appendChild(overlay);
                overlay.querySelector('#ed-cerebras-key').value = Ed.Config.safeGetKey("cerebras_key");

                const btn = document.getElementById('ed-save-keys');
                btn.focus();

                btn.addEventListener('click', async () => {
                    const ck = overlay.querySelector('#ed-cerebras-key').value.trim();

                    if (!ck) { alert("Please provide your Cerebras API key."); return; }

                    btn.disabled = true;
                    btn.textContent = "Validating...";

                    let cerebrasValid = true;

                    const cerebrasError = overlay.querySelector('#cerebras-key-error');
                    const cerebrasValidating = overlay.querySelector('#cerebras-key-validating');
                    cerebrasError.classList.remove('show');
                    cerebrasValidating.classList.add('show');

                    const result = await Ed.AI.validateKey('cerebras', ck);
                    cerebrasValidating.classList.remove('show');

                    if (result.valid === false) {
                        cerebrasValid = false;
                        cerebrasError.textContent = `❌ ${result.error}`;
                        cerebrasError.classList.add('show');
                    } else if (result.valid === null) {
                        cerebrasError.textContent = `⚠️ Could not verify (network error). Key will be saved anyway.`;
                        cerebrasError.style.color = '#f59e0b';
                        cerebrasError.classList.add('show');
                    }

                    if (!cerebrasValid) {
                        btn.disabled = false;
                        btn.textContent = "Save & Continue";
                        Ed.Notifications.showInvalidKeyModal("Cerebras", overlay.querySelector('#cerebras-key-error').textContent.replace('❌ ', ''));
                        return;
                    }

                    Ed.Config.set("cerebras_key", Ed.Config.encode(ck));
                    Ed.UI.closeModalSmoothly(overlay, resolve);
                });
            });
        },

        animateSettingsApplication: async (settingsMap) => {
            const panel = Ed.UI.panelElement;
            if (!panel) return;

            const shadow = panel.getRootNode();
            const wait = (ms) => new Promise(r => setTimeout(r, ms));

            const animateRow = async (key, value) => {
                const row = shadow.querySelector(`.row[data-key="${key}"]`);
                if (!row) return;

                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.style.transition = 'background 0.2s, border-color 0.2s';
                row.style.background = 'rgba(16, 185, 129, 0.2)';
                row.style.borderColor = 'rgba(16, 185, 129, 0.5)';

                await wait(300);

                const toggle = row.querySelector('.toggle');
                if (toggle) {
                    if (value === true) toggle.classList.add('active');
                    else toggle.classList.remove('active');
                }

                const input = row.querySelector('.delay-input');
                if (input && typeof value === 'string') {
                    input.value = value;
                    input.style.background = 'rgba(16, 185, 129, 0.3)';
                    await wait(200);
                    input.style.background = '';
                }

                await wait(200);
                row.style.background = '';
                row.style.borderColor = '';
            };

            for (const [key, val] of Object.entries(settingsMap)) {
                await animateRow(key, val);
                await wait(100);
            }

            for (const [key, val] of Object.entries(settingsMap)) {
                Ed.Config.set(key, val);
                if (key === "BACKGROUND_MODE") Ed.Recovery.toggleAntiThrottle(val);

                if (key === "AUTO_TUTORIAL_ENABLED" && val === true) Ed.Tutorial.tryStartTutorial();
                if (key === "AUTO_ANSWER_ENABLED" && val === true) Ed.Answer.startAnswer(true);
            }

            Ed.UI.showToast("Setup Complete! Starting...", 3000);
        },

        showRecommendedSettingsModal: () => {
            return new Promise((resolve) => {
                if (Ed.Config.get("HAS_SEEN_RECOMMENDED_MODAL", false)) return resolve();

                if (window.self !== window.top || document.getElementById('ed-recom-modal')) return resolve();
                Ed.UI.injectGlobalModalStyles();
                const overlay = document.createElement('div'); overlay.id = 'ed-recom-modal';
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');
                overlay.innerHTML = `
                    <div class="modal-box" style="width: 420px; text-align: center;">
                        <div class="modal-title" style="justify-content: center;">🚀 Recommended Setup</div>
                        <div class="modal-desc" style="font-size: 14px; margin-bottom: 30px;">
                            Apply optimal settings?<br>
                            <strong>Auto Tutorial:</strong> ON (300-420s initial delay)<br>
                            <strong>Auto Answer:</strong> ON (25-35s delay)<br>
                            <strong>Background Mode:</strong> ON<br>
                            <strong>Auto Notify:</strong> ON<br>
                            <strong>Auto Advance:</strong> ON<br>
                            <strong>Cerebras Reasoning:</strong> ON
                        </div>
                        <div class="btn-row">
                            <button class="save-btn btn-secondary" id="btn-no-recom">No, skip</button>
                            <button class="save-btn" id="btn-yes-recom">Yes, apply</button>
                        </div>
                    </div>`;
                document.body.appendChild(overlay);

                const btnYes = document.getElementById('btn-yes-recom');
                const btnNo = document.getElementById('btn-no-recom');
                btnYes.focus();

                const handleClose = (result) => {
                    Ed.Config.set("HAS_SEEN_RECOMMENDED_MODAL", true);
                    overlay.remove();
                    document.dispatchEvent(new CustomEvent('ed-modal-closed'));
                    resolve(result);
                };

                btnNo.addEventListener('click', () => handleClose(false));

                btnYes.addEventListener('click', async () => {
                    handleClose(true);

                    const settings = {
                        "AUTO_TUTORIAL_ENABLED": true,
                        "TUTORIAL_DELAY": "300-420",
                        "AUTO_ANSWER_ENABLED": true,
                        "ANSWER_DELAY": "25-35",
                        "AUTO_ACTIVITY_ENABLED": true,
                        "AUTO_ADVANCE_ENABLED": true,
                        "BACKGROUND_MODE": true,
                        "AUTO_NOTIFY": true,
                        "TOAST_ENABLED": true,
                        "CONFIRM_SUBMIT": false,
                        "CEREBRAS_REASONING": true
                    };

                    await Ed.UI.animateSettingsApplication(settings);

                    Ed.Notifications.requestPermAndShowModal();
                    Ed.Notifications.showBackgroundModeInfo();
                    Ed.Notifications.showSettingsAppliedModal();
                });
            });
        },

        updateToggle: (key, isActive) => {
            if (!Ed.UI.panelElement) return;
            const shadow = Ed.UI.panelElement.getRootNode();
            const toggle = shadow.querySelector(`.row[data-key="${key}"] .toggle`);
            if (toggle) {
                if (isActive) toggle.classList.add('active');
                else toggle.classList.remove('active');
            }
        },

        initUI: () => {
            if (window.self !== window.top) return;

            window.addEventListener('keydown', (e) => {
                if (e.altKey && e.key.toLowerCase() === 'h') {
                    e.preventDefault();
                    const host = document.getElementById('ed-ui-host');
                    if (!host) return;

                    if (e.shiftKey) {
                        let isForceHidden = Ed.Config.get("UI_FORCE_HIDDEN", false);
                        Ed.Config.set("UI_FORCE_HIDDEN", !isForceHidden);
                        host.style.display = !isForceHidden ? 'none' : 'block';
                        if (!isForceHidden) Ed.UI.showToast("UI permanently hidden. Press Alt+Shift+H to restore.", 4000);
                    } else {
                        if (host.style.display === 'none') {
                            host.style.display = 'block';
                            Ed.Config.set("UI_FORCE_HIDDEN", false);
                        } else {
                            host.style.display = 'none';
                        }
                    }
                }
            });

            const host = document.createElement('div'); host.id = 'ed-ui-host'; host.style = 'position:fixed; top:25px; right:25px; z-index:9999999;'; document.body.appendChild(host);
            if (Ed.Config.get("UI_FORCE_HIDDEN", false)) host.style.display = 'none';

            const savedPos = Ed.Config.get("UI_POSITION");
            if (savedPos) {
                host.style.left = savedPos.left;
                host.style.top = savedPos.top;
                host.style.right = 'auto';
            }

            const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

            .icon { width: 14px; height: 14px; fill: currentColor; display: inline-block; vertical-align: middle; }
            .icon-lg { width: 18px; height: 18px; }

            #panel { width: 380px; background: rgba(15, 23, 42, 0.98); border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.8); overflow: hidden; border: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(20px); user-select: none; transition: box-shadow 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
            #panel.solving { box-shadow: 0 0 35px rgba(16, 185, 129, 0.4); border-color: rgba(16, 185, 129, 0.4); }
            .header { padding: 18px 24px; display: flex; align-items: center; gap: 12px; cursor: move; background: rgba(30, 41, 59, 0.9); border-bottom: 1px solid rgba(255,255,255,0.05); }
            .logo { background: linear-gradient(135deg, #10b981, #3b82f6); width: 28px; height: 28px; display: flex; justify-content: center; align-items: center; border-radius: 8px; font-size: 16px; color: white; font-weight: 600; text-align: center; line-height: 28px; box-shadow: 0 4px 10px rgba(16, 185, 129, 0.3); }
            .title { color: #f8fafc; font-weight: 700; font-size: 15px; letter-spacing: -0.3px; flex: 1; }
            .header-btns { display: flex; gap: 10px; }
            .header-btn { background: none; border: none; color: #64748b; font-size: 18px; cursor: pointer; transition: color 0.2s; line-height: 1; padding: 0; }
            .header-btn:hover { color: #f8fafc; }
            .tabs { display: flex; background: rgba(30, 41, 59, 0.6); border-bottom: 1px solid rgba(255,255,255,0.05); }
            .tab { flex: 1; text-align: center; padding: 14px 0; color: #64748b; font-size: 12px; font-weight: 700; cursor: pointer; transition: color 0.2s, border-color 0.2s; border-bottom: 2px solid transparent; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; justify-content: center; gap: 6px; }
            .tab:hover { color: #94a3b8; }
            .tab.active { color: #f8fafc; border-bottom: 2px solid #10b981; }
            .tab svg { width: 14px; height: 14px; }
            .tab-content { display: none; } .tab-content.active { display: block; }
            .content { padding: 16px 20px 20px; overflow-y: auto; max-height: 600px; }
            .content::-webkit-scrollbar { width: 6px; } .content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
            .row { background: rgba(30, 41, 59, 0.6); margin-bottom: 12px; padding: 14px 16px; border-radius: 14px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background 0.2s, transform 0.1s; border: 1px solid transparent; }
            .row:hover { background: rgba(51, 65, 85, 0.6); border-color: rgba(255,255,255,0.05); }
            .row:active { transform: scale(0.98); }
            .row-label { display: flex; flex-direction: column; gap: 5px; flex: 1; pointer-events: none; }
            .row-title { color: #f1f5f9; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
            .row-desc { color: #94a3b8; font-size: 12px; font-weight: 400; padding-right: 12px; line-height: 1.4; }
            .row-controls { display: flex; align-items: center; gap: 12px; }
            .delay-input { width: 60px; padding: 6px; background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(255,255,255,0.1); color: #f8fafc; border-radius: 8px; text-align: center; font-size: 12px; outline: none; font-family: inherit; transition: border 0.2s; }
            .delay-input:focus { border-color: #10b981; }
            .delay-unit { color: #64748b; font-size: 11px; pointer-events: none; text-transform: uppercase; font-weight: 600; }
            .toggle { width: 44px; height: 24px; background: #334155; border-radius: 24px; position: relative; cursor: pointer; transition: background 0.3s, border-color 0.3s; pointer-events: none; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.05); }
            .toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; background: white; border-radius: 50%; transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.2s; }
            .toggle.active { background: #10b981; border-color: #10b981; }
            .toggle.active::after { transform: translateX(20px); box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
            .about-content { padding: 24px; color: #94a3b8; font-size: 13px; line-height: 1.7; }
            .about-title { color: #f8fafc; font-size: 18px; font-weight: 700; margin-bottom: 15px; background: linear-gradient(135deg, #10b981, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .section-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 16px 0; }
            .section-label { color: #64748b; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 12px; padding-left: 2px; display: flex; align-items: center; gap: 8px; }
            .section-label::after { content: ''; height: 1px; flex: 1; background: rgba(255,255,255,0.05); }
            .hidden { display: none !important; }

            .resume-btn { width: 100%; margin-top: 12px; padding: 14px; background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; border-radius: 12px; font-weight: 700; font-size: 14px; cursor: pointer; text-align: center; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3); transition: transform 0.2s; }
            .resume-btn:hover { transform: translateY(-1px); filter: brightness(1.1); }

            .api-card { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 15px; margin-bottom: 15px; transition: border-color 0.2s, background 0.2s; }
            .api-card:hover { border-color: rgba(16, 185, 129, 0.4); background: rgba(30, 41, 59, 0.8); }
            .api-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            .api-card-title { color: #f1f5f9; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
            .api-link { color: #10b981; text-decoration: none; font-size: 11px; font-weight: 600; padding: 4px 8px; background: rgba(16, 185, 129, 0.1); border-radius: 6px; transition: background 0.2s; }
            .api-link:hover { background: rgba(16, 185, 129, 0.2); }
            .api-input-wrapper { display: flex; gap: 8px; align-items: center; background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(255,255,255,0.1); padding: 4px; border-radius: 8px; transition: border-color 0.2s; }
            .api-input-wrapper:focus-within { border-color: #10b981; box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2); }
            .api-key-input { flex: 1; background: transparent; border: none; color: #f8fafc; font-size: 13px; font-family: monospace; padding: 8px 6px; outline: none; }
            .api-action-btn { background: transparent; border: none; color: #64748b; cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: background 0.2s, color 0.2s; }
            .api-action-btn:hover { background: rgba(255,255,255,0.1); color: #f8fafc; }
            .api-status { font-size: 11px; margin-top: 8px; font-weight: 500; display: none; }
            .api-status.success { color: #10b981; display: block; }
            .api-status.error { color: #ef4444; display: block; }
            .api-status.validating { color: #3b82f6; display: block; }

            .faq-q { color: #f8fafc; font-weight: 600; margin-top: 15px; margin-bottom: 5px; }
            .faq-a { color: #94a3b8; font-size: 12px; margin-bottom: 10px; }
        `;
        shadow.appendChild(style);
        const p = document.createElement('div'); p.id = 'panel';
        Ed.UI.panelElement = p;

        const tutVal = Ed.Config.get("TUTORIAL_DELAY") || "30";
        const testVal = Ed.Config.get("ANSWER_DELAY") || "25-35";

        const tutActive = Ed.Config.get("AUTO_TUTORIAL_ENABLED", false) ? 'active' : '';
        const testActive = Ed.Config.get("AUTO_ANSWER_ENABLED", false) ? 'active' : '';
        const actActive = Ed.Config.get("AUTO_ACTIVITY_ENABLED", false) ? 'active' : '';
        const autoAdvActive = Ed.Config.get("AUTO_ADVANCE_ENABLED", false) ? 'active' : '';
        const confirmSubmitActive = Ed.Config.get("CONFIRM_SUBMIT", false) ? 'active' : '';
        const autoNotifActive = Ed.Config.get("AUTO_NOTIFY", true) ? 'active' : '';
        const toastActive = Ed.Config.get("TOAST_ENABLED", true) ? 'active' : '';
        const bgModeActive = Ed.Config.get("BACKGROUND_MODE", false) ? 'active' : '';
        const autoHideActive = Ed.Config.get("AUTOHIDE_ENABLED", false) ? 'active' : '';
        const reasoningActive = Ed.Config.get("CEREBRAS_REASONING", true) ? 'active' : '';

        p.innerHTML = `
            <div class="header"><div class="logo">E</div><div class="title">Edmentum Solver <span id="version-tag" style="font-size: 10px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: 500;">v1.1.0</span></div><div class="header-btns"><button class="header-btn" id="collapse-btn">—</button><button class="header-btn" id="hide-btn">✕</button></div></div>
            <div id="panel-body">
               <div class="tabs">
                    <div class="tab active" data-tab="features"><svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Features</div>
                    <div class="tab" data-tab="api"><svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> API</div>
                    <div class="tab" data-tab="about"><svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> About</div>
               </div>
                <div class="tab-content active" id="tab-features">
                    <div class="content">
                        <div class="section-label">Core Automation</div>
                        <div class="row" data-key="AUTO_TUTORIAL_ENABLED">
                            <div class="row-label"><div class="row-title">Auto Tutorial</div><div class="row-desc">Navigates through tutorial slides</div></div>
                            <div class="row-controls"><input type="text" class="delay-input" data-delay="TUTORIAL_DELAY" value="${tutVal}"><span class="delay-unit">s</span><div class="toggle ${tutActive}"></div></div>
                        </div>
                        <div class="row" data-key="AUTO_ANSWER_ENABLED">
                            <div class="row-label"><div class="row-title">Auto Answer</div><div class="row-desc">Answers test questions with AI</div></div>
                            <div class="row-controls"><input type="text" class="delay-input" data-delay="ANSWER_DELAY" value="${testVal}"><span class="delay-unit">s</span><div class="toggle ${testActive}"></div></div>
                        </div>
                        <div class="row" data-key="AUTO_ACTIVITY_ENABLED">
                            <div class="row-label"><div class="row-title">Auto Enter Activity</div><div class="row-desc">Automatically enters the next module</div></div>
                            <div class="row-controls"><div class="toggle ${actActive}"></div></div>
                        </div>
                        <div class="row" data-key="AUTO_ADVANCE_ENABLED">
                            <div class="row-label"><div class="row-title">Auto Advance</div><div class="row-desc">Automatically moves to the next activity when complete</div></div>
                            <div class="row-controls"><div class="toggle ${autoAdvActive}"></div></div>
                        </div>
                        <div class="row" data-key="CONFIRM_SUBMIT">
                            <div class="row-label"><div class="row-title">Confirm Before Submit</div><div class="row-desc">Halts script at the end to let you review answers</div></div>
                            <div class="row-controls"><div class="toggle ${confirmSubmitActive}"></div></div>
                        </div>
                        <button class="resume-btn" id="ed-resume-btn" style="display:none;">▶ Resume & Submit</button>

                        <div class="section-divider"></div>
                        <div class="section-label">Background</div>
                        <div class="row" data-key="BACKGROUND_MODE">
                            <div class="row-label"><div class="row-title">Background Mode</div><div class="row-desc">Prevents throttling when tab is out of focus</div></div>
                            <div class="row-controls"><div class="toggle ${bgModeActive}"></div></div>
                        </div>

                        <div class="section-divider"></div>
                        <div class="section-label">Notifications</div>
                        <div class="row" data-key="AUTO_NOTIFY">
                            <div class="row-label"><div class="row-title">Desktop Notifications</div><div class="row-desc">Alerts you on completion or stuck failures</div></div>
                            <div class="row-controls"><div class="toggle ${autoNotifActive}"></div></div>
                        </div>
                        <div class="row" data-key="TOAST_ENABLED">
                            <div class="row-label"><div class="row-title">UI Toasts</div><div class="row-desc">Shows status popups at bottom of screen</div></div>
                            <div class="row-controls"><div class="toggle ${toastActive}"></div></div>
                        </div>

                        <div class="section-divider"></div>
                        <div class="section-label">Privacy</div>
                        <div class="row" data-key="AUTOHIDE_ENABLED">
                            <div class="row-label"><div class="row-title">Auto Hide Personal Info</div><div class="row-desc">Hides name, avatar, and date from the header</div></div>
                            <div class="row-controls"><div class="toggle ${autoHideActive}"></div></div>
                        </div>
                    </div>
                </div>
                <div class="tab-content" id="tab-api">
                    <div class="content">
                        <div class="section-label">API Keys (Manage Only)</div>
                        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 15px; line-height: 1.5; padding: 10px; background: rgba(16, 185, 129, 0.1); border-radius: 10px; border: 1px solid rgba(16, 185, 129, 0.2);">
                            Connect your Cerebras API provider to solve questions using Z.ai GLM 4.7.
                        </div>

                        <div class="api-card" data-provider="cerebras">
                            <div class="api-card-header">
                                <div class="api-card-title"><span style="color:#f97316; font-weight: bold;">C</span> Cerebras</div>
                                <a href="https://cloud.cerebras.ai" target="_blank" class="api-link">Get Key ↗</a>
                            </div>
                            <div class="api-input-wrapper">
                                <input type="password" class="api-key-input" id="api-cerebras-input" placeholder="sk-...">
                                <button class="api-action-btn api-toggle-vis" title="Show/Hide">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                </button>
                                <button class="api-action-btn api-delete-key" title="Delete">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                </button>
                            </div>
                            <div class="api-status" id="api-cerebras-status"></div>
                        </div>

                        <div class="section-divider"></div>
                        <div class="section-label">AI Settings</div>
                        <div class="row" data-key="CEREBRAS_REASONING">
                            <div class="row-label">
                                <div class="row-title">Enable Reasoning</div>
                                <div class="row-desc">Generates deep step-by-step thinking for maximum accuracy. Disabling reasoning will produce immediate, shorter answers.</div>
                            </div>
                            <div class="row-controls">
                                <div class="toggle ${reasoningActive}"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="tab-content" id="tab-about"><div class="about-content">
                    <div class="about-title">Edmentum Solver v1.1.0</div>
                    <div style="margin-bottom: 10px;">Made by floor with AI.<br>Press <strong>Alt + H</strong> to hide UI (Shift+Alt+H for permanent hide).</div>

                    <div class="section-divider"></div>
                    <div class="about-title" style="font-size:14px; margin-bottom:8px;">FAQ</div>
                    <div class="faq-q">What does this script automate?</div>
                    <div class="faq-a">The script can automate tests and tutorials, and be able to autoenter them and go to next lesson, it cannot do teacher graded activities.</div>

                    <div class="faq-q">Is the AI 100% perfect?</div>
                    <div class="faq-a">No, the AI is not 100% perfect. You can turn on Confirm Before Submit option in the UI so you can check the AI's answers.</div>

                    <div class="faq-q">How do range delays work?</div>
                    <div class="faq-a">Enter e.g. <code>25-35</code> to pick a random delay between 25s and 35s.</div>

                    <div class="faq-q">Why does the script randomly pause?</div>
                    <div class="faq-a">It will pause if "Confirm Before Submit" is enabled or if rate limits (5 requests/min) are active. It automatically ticks down to continue.</div>

                    <div class="faq-q">How do I get Desktop Notifications?</div>
                    <div class="faq-a">Enable Auto Notify and allow system permissions in your browser.</div>
                </div></div>
            </div>
        `;
        shadow.appendChild(p);

        const panelBody = shadow.getElementById('panel-body');
        if (Ed.Config.get("UI_COLLAPSED", false)) panelBody.classList.add('hidden');

        const cerebrasInput = shadow.getElementById('api-cerebras-input');
        if (cerebrasInput) cerebrasInput.value = Ed.Config.safeGetKey("cerebras_key");

        shadow.querySelectorAll('.api-card').forEach(row => {
            const input = row.querySelector('.api-key-input');
            const toggleBtn = row.querySelector('.api-toggle-vis');
            const deleteBtn = row.querySelector('.api-delete-key');
            const statusEl = row.querySelector('.api-status');
            const provider = row.dataset.provider;

            toggleBtn.addEventListener('click', () => {
                input.type = input.type === 'password' ? 'text' : 'password';
            });

            deleteBtn.addEventListener('click', () => {
                if (confirm(`Are you sure you want to delete your ${provider} API key?`)) {
                    Ed.Config.set(`${provider}_key`, '');
                    input.value = '';
                    statusEl.className = 'api-status';
                    statusEl.textContent = '';
                    Ed.UI.showToast(`${provider} key deleted.`, 2000);
                }
            });

            input.addEventListener('change', async () => {
                const val = input.value.trim();
                if (val) {
                    statusEl.className = 'api-status validating';
                    statusEl.textContent = '⏳ Validating...';

                    const result = await Ed.AI.validateKey(provider, val);

                    if (result.valid) {
                        statusEl.className = 'api-status success';
                        statusEl.textContent = '✅ Key is valid and saved.';
                        Ed.Config.set(`${provider}_key`, Ed.Config.encode(val));
                        Ed.UI.showToast(`${provider} key updated.`, 2000);
                    } else if (result.valid === null) {
                        statusEl.className = 'api-status validating';
                        statusEl.style.color = '#f59e0b';
                        statusEl.textContent = '⚠️ Could not verify (network error). Saved anyway.';
                        Ed.Config.set(`${provider}_key`, Ed.Config.encode(val));
                    } else {
                        statusEl.className = 'api-status error';
                        statusEl.textContent = `❌ ${result.error}`;
                        Ed.Config.set(`${provider}_key`, Ed.Config.encode(val));
                    }
                } else {
                    Ed.Config.set(`${provider}_key`, '');
                    statusEl.className = 'api-status';
                    statusEl.textContent = '';
                }
            });
        });

        const resumeBtn = shadow.getElementById('ed-resume-btn');
        resumeBtn.addEventListener('click', () => {
            Ed.State.manuallyPausedSubmission = false;
            resumeBtn.style.display = 'none';
            Ed.UI.showToast("Resuming submission...", 2000);
            Ed.Answer.clickSubmitOrNext();
        });

        shadow.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                shadow.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                shadow.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                shadow.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
            });
        });

        shadow.querySelectorAll('.row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.tagName === 'SELECT') return;
                if (e.target.classList.contains('delay-input')) return;
                const toggle = row.querySelector('.toggle');
                if (!toggle) return;

                const key = row.dataset.key;
                const isActive = !toggle.classList.contains('active');
                if (isActive) toggle.classList.add('active'); else toggle.classList.remove('active');
                Ed.Config.set(key, isActive);

                if (key === "AUTO_NOTIFY" && isActive) Ed.Notifications.requestPermAndShowModal();
                if (key === "BACKGROUND_MODE") Ed.Recovery.toggleAntiThrottle(isActive);
                if (key === "AUTOHIDE_ENABLED") Ed.UI.toggleAutoHide(isActive);
                if (key === "CEREBRAS_REASONING") {
                    Ed.UI.showToast(`Reasoning ${isActive ? 'enabled' : 'disabled'}.`, 2000);
                }

                if (key === "AUTO_ANSWER_ENABLED") {
                    if (isActive) Ed.Answer.startAnswer(false);
                    else Ed.Answer.stopAnswer();
                }
                if (key === "AUTO_TUTORIAL_ENABLED") {
                    if (isActive) Ed.Tutorial.tryStartTutorial();
                    else Ed.Tutorial.disableTutorialMode();
                }
            });
        });

        shadow.querySelectorAll('.delay-input').forEach(input => {
            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('change', (e) => {
                let val = e.target.value.trim();
                if (!/^(\d+)(-\d+)?$/.test(val)) val = "5";
                e.target.value = val;
                Ed.Config.set(e.target.dataset.delay, val);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    let val = e.target.value.trim();
                    if (!/^(\d+)(-\d+)?$/.test(val)) val = "5";
                    e.target.value = val;
                    Ed.Config.set(e.target.dataset.delay, val);
                    e.target.blur();
                }
            });
        });

        shadow.getElementById('collapse-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const nowHidden = panelBody.classList.toggle('hidden');
            Ed.Config.set("UI_COLLAPSED", nowHidden);
        });
        shadow.getElementById('hide-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            host.style.display = 'none';
        });

        let isDragging = false, startX, startY; const header = p.querySelector('.header');
        const onMove = (e) => {
            if (!isDragging) return;
            host.style.right = 'auto';
            let newX = Math.max(-host.offsetWidth + 60, Math.min(e.clientX - startX, window.innerWidth - 60));
            let newY = Math.max(0, Math.min(e.clientY - startY, window.innerHeight - 40));
            host.style.left = newX + 'px';
            host.style.top = newY + 'px';
        };
        const onUp = () => {
            isDragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            Ed.Config.set("UI_POSITION", { left: host.style.left, top: host.style.top });
        };
        header.addEventListener('mousedown', (e) => { if (e.target.closest('.header-btns')) return; isDragging = true; startX = e.clientX - host.offsetLeft; startY = e.clientY - host.offsetTop; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); });
    }
};

// ========================================================================
// AUTO ACTIVITY URL WATCHER
// ========================================================================
let lastUrl = location.href;
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
            if (Ed.Config.get('AUTO_ACTIVITY_ENABLED', false) || Ed.Config.get('AUTO_ADVANCE_ENABLED', false)) Ed.Nav.autoNavigate();
            if (Ed.Config.get('AUTO_TUTORIAL_ENABLED', false)) Ed.Tutorial.tryStartTutorial();
        }, 2000);
    }
}).observe(document, { subtree: true, childList: true });

// ========================================================================
// INITIALIZATION
// ========================================================================
if (window.self === window.top && !Ed.Utils.isLoginPage()) {
    window.addEventListener('load', async () => {
        if (!Ed.Config.safeGetKey("cerebras_key")) {
            await Ed.UI.showSetupModal();
        }

        Ed.UI.initUI();
        await Ed.UI.showRecommendedSettingsModal();

        if (Ed.Config.get('BACKGROUND_MODE', false)) Ed.Recovery.toggleAntiThrottle(true);
        if (Ed.Config.get('AUTOHIDE_ENABLED', false)) Ed.UI.toggleAutoHide(true);

        // Periodic background check so you NEVER need to reload to AutoAdvance
        setInterval(() => {
            if (!Ed.State.tutorialRunning && Ed.Config.get('AUTO_TUTORIAL_ENABLED', false)) {
                Ed.Tutorial.tryStartTutorial();
            }

            if (!Ed.State.tutorialRunning && (Ed.Config.get('AUTO_ACTIVITY_ENABLED', false) || Ed.Config.get('AUTO_ADVANCE_ENABLED', false))) {
                Ed.Nav.autoNavigate();
            }
        }, 3000);


        setTimeout(() => {
            if (Ed.Config.get('AUTO_ACTIVITY_ENABLED', false)) Ed.Nav.autoNavigate();
            if (Ed.Config.get('AUTO_TUTORIAL_ENABLED', false)) Ed.Tutorial.tryStartTutorial();
            if (Ed.Config.get('AUTO_ANSWER_ENABLED', false)) Ed.Answer.startAnswer(true);
        }, 2000);
    });
}

})();
