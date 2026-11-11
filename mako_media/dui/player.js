'use strict';

/*
 * mako_media DUI page. One page = one media player handle.
 *
 * Messages from Lua (SendDuiMessage):
 *   load     { mediaId, url, title, offset, ready, paused, duration }
 *   settings { filter, visualization, visualizationOptions, showVideo }
 *   time     { offset, paused, ready, duration, loop }
 *   mix      { volume, pan }
 *   stop     {}
 *
 * Callbacks to Lua (NUI callbacks): duiReady, duiMeta, duiError
 */

(function () {
	const params = new URLSearchParams(window.location.search);
	const RES = params.get('res') || 'mako_media';
	const HANDLE = params.get('h') || '';
	const MAX_DRIFT = 1.5;

	const S = {
		media: null,
		mediaId: null,
		url: null,
		metaSent: false,
		live: false,
		duration: 0,
		serverReady: false,
		paused: true,
		loop: false,
		target: 0,
		targetAt: 0,
		volume: 0,
		pan: 0,
		filter: false,
		visualization: false,
		visOptions: null,
		showVideo: true,
		graph: null,
		graphDisabled: false,
		silentChecks: 0,
		adTimer: null,
		silenceTimer: null
	};

	const wave = typeof Wave === 'function' ? new Wave() : null;
	let visFrame = 0;
	let visData = null;

	function post(name, data) {
		return fetch('https://' + RES + '/' + name, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data || {})
		}).catch(() => {});
	}

	function setLoading(on) {
		document.body.classList.toggle('loading', on);
	}

	function resolveUrl(url) {
		if (/^https?:\/\//i.test(url)) {
			return url;
		}
		return new URL('../media/' + encodeURIComponent(url), window.location.href).href;
	}

	// The real <video>/<audio> element behind a MediaElement renderer.
	function innerElement(media) {
		try {
			if (media.youTubeApi) {
				const iframe = media.youTubeApi.getIframe();
				return iframe.contentWindow.document.querySelector('video');
			}
			if (media.hlsPlayer && media.hlsPlayer.media) {
				return media.hlsPlayer.media;
			}
			if (media.dashPlayer && media.dashPlayer.getVideoElement) {
				return media.dashPlayer.getVideoElement();
			}
			if (media.originalNode && media.originalNode instanceof HTMLMediaElement) {
				return media.originalNode;
			}
			if (media instanceof HTMLMediaElement) {
				return media;
			}
		} catch (e) {
			// Cross-origin iframe: no direct access.
		}
		return null;
	}

	function iframeDocument(media) {
		try {
			if (media.youTubeApi) return media.youTubeApi.getIframe().contentWindow.document;
			if (media.twitchPlayer && media.twitchPlayer._iframe) return media.twitchPlayer._iframe.contentWindow.document;
		} catch (e) {}
		return null;
	}

	/* ---------------------------------------------------------------- audio */

	function buildGraph() {
		if (S.graph || S.graphDisabled || !S.media) return;

		const el = innerElement(S.media);
		if (!el) return;

		try {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			const ctx = new Ctx();
			const source = ctx.createMediaElementSource(el);

			const highpass = ctx.createBiquadFilter();
			highpass.type = 'highpass';
			highpass.frequency.value = 280;

			const lowpass = ctx.createBiquadFilter();
			lowpass.type = 'lowpass';
			lowpass.frequency.value = 3800;

			const shaper = ctx.createWaveShaper();
			shaper.curve = makeDriveCurve(6);

			const compressor = ctx.createDynamicsCompressor();
			compressor.threshold.value = -24;
			compressor.ratio.value = 6;

			const radioGain = ctx.createGain();
			radioGain.gain.value = 0.9;

			const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
			const gain = ctx.createGain();
			gain.gain.value = 0;

			const analyser = ctx.createAnalyser();
			analyser.fftSize = 2048;

			el.volume = 1;
			el.muted = false;
			if (S.media.youTubeApi) {
				try { S.media.youTubeApi.setVolume(100); S.media.youTubeApi.unMute(); } catch (e) {}
			}

			S.graph = { ctx, source, highpass, lowpass, shaper, compressor, radioGain, panner, gain, analyser, el };
			visData = new Uint8Array(analyser.frequencyBinCount);

			wireGraph();

			if (ctx.state === 'suspended') ctx.resume();

			startSilenceCheck();
		} catch (e) {
			console.warn('[mako_media] audio graph unavailable:', e);
			S.graph = null;
		}
	}

	function makeDriveCurve(amount) {
		const n = 1024;
		const curve = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const x = (i * 2) / n - 1;
			curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
		}
		return curve;
	}

	function wireGraph() {
		const g = S.graph;
		if (!g) return;

		[g.source, g.highpass, g.lowpass, g.shaper, g.compressor, g.radioGain, g.panner, g.gain].forEach(node => {
			if (node) {
				try { node.disconnect(); } catch (e) {}
			}
		});

		g.source.connect(g.analyser);

		let last = g.source;

		if (S.filter) {
			last.connect(g.highpass);
			g.highpass.connect(g.lowpass);
			g.lowpass.connect(g.shaper);
			g.shaper.connect(g.compressor);
			g.compressor.connect(g.radioGain);
			last = g.radioGain;
		}

		if (g.panner) {
			last.connect(g.panner);
			last = g.panner;
		}

		last.connect(g.gain);
		g.gain.connect(g.ctx.destination);
	}

	// If the graph only ever outputs silence (cross-origin media without
	// CORS), reload the media without it so sound still works.
	function startSilenceCheck() {
		stopSilenceCheck();
		S.silentChecks = 0;

		S.silenceTimer = setInterval(() => {
			const g = S.graph;
			const media = S.media;
			if (!g || !media) return stopSilenceCheck();
			if (media.paused || S.volume < 0.02) return;

			g.analyser.getByteFrequencyData(visData);
			let max = 0;
			for (let i = 0; i < visData.length; i++) {
				if (visData[i] > max) max = visData[i];
			}

			if (max === 0) {
				S.silentChecks++;
				if (S.silentChecks >= 5) {
					console.warn('[mako_media] audio graph silent, reloading without it');
					stopSilenceCheck();
					S.graphDisabled = true;
					reload();
				}
			} else {
				S.silentChecks = 0;
				if (max > 0) stopSilenceCheck();
			}
		}, 1000);
	}

	function stopSilenceCheck() {
		if (S.silenceTimer) {
			clearInterval(S.silenceTimer);
			S.silenceTimer = null;
		}
	}

	function applyMix() {
		const media = S.media;
		if (!media) return;

		const g = S.graph;

		if (g) {
			const t = g.ctx.currentTime;
			g.gain.gain.setTargetAtTime(S.volume, t, 0.12);
			if (g.panner) g.panner.pan.setTargetAtTime(S.pan, t, 0.12);
			if (g.ctx.state === 'suspended') g.ctx.resume();
		} else {
			try {
				media.setVolume(Math.max(0, Math.min(1, S.volume)));
			} catch (e) {
				media.volume = Math.max(0, Math.min(1, S.volume));
			}
		}
	}

	/* -------------------------------------------------------- visualization */

	function applyVisual() {
		const on = !!(S.visualization && S.graph && wave);
		document.body.classList.toggle('vis', on);
	}

	function renderVisual() {
		requestAnimationFrame(renderVisual);

		if (!S.visualization || !S.graph || !wave) return;

		visFrame++;
		S.graph.analyser.getByteFrequencyData(visData);

		const options = Object.assign({}, S.visOptions || {});
		options.type = options.type || S.visualization;

		try {
			wave.visualize(visData, 'vis', options, visFrame);
		} catch (e) {}
	}

	/* ---------------------------------------------------------------- media */

	function destroy() {
		stopSilenceCheck();

		if (S.adTimer) {
			clearInterval(S.adTimer);
			S.adTimer = null;
		}

		if (S.graph) {
			try { S.graph.ctx.close(); } catch (e) {}
			S.graph = null;
		}

		if (S.media) {
			try { S.media.pause(); } catch (e) {}
			try { S.media.remove(); } catch (e) {}
		}

		S.media = null;
		document.getElementById('stage').innerHTML = '';
		document.body.classList.remove('vis');
	}

	function reload() {
		const offset = currentExpected();
		createMedia(S.url, offset);
	}

	function load(msg) {
		S.mediaId = msg.mediaId;
		S.url = msg.url;
		S.metaSent = false;
		S.graphDisabled = false;
		S.serverReady = !!msg.ready;
		S.paused = !!msg.paused;
		S.duration = msg.duration || 0;
		S.live = msg.duration === false;
		setTarget(msg.offset || 0);

		createMedia(msg.url, msg.offset || 0);
	}

	function createMedia(url, startAt) {
		destroy();
		setLoading(true);

		const id = 'media_' + S.mediaId + '_' + Date.now();
		const node = document.createElement('video');
		node.id = id;
		node.setAttribute('playsinline', '');
		node.setAttribute('preload', 'auto');
		node.src = resolveUrl(url);
		document.getElementById('stage').appendChild(node);

		const mediaId = S.mediaId;

		new MediaElement(id, {
			startVolume: 0,
			youtube: { imageQuality: 'maxresdefault' },
			error: function (media) {
				setLoading(false);
				fail(mediaId, (media && media.error && media.error.message) || 'unsupported media');
			},
			success: function (media) {
				if (mediaId !== S.mediaId) {
					try { media.remove(); } catch (e) {}
					return;
				}

				S.media = media;
				let initialised = false;

				try { media.setVolume(0); } catch (e) {}

				media.addEventListener('error', () => {
					setLoading(false);
					fail(mediaId, (media.error && media.error.message) || 'playback error');
				});

				const onReady = () => {
					if (initialised || mediaId !== S.mediaId) return;
					initialised = true;
					setLoading(false);

					let duration = Number(media.duration);
					if (media.youTubeApi) {
						try { duration = media.youTubeApi.getDuration(); } catch (e) {}
					}

					const live = !isFinite(duration) || !(duration > 0);
					S.live = live;
					S.duration = live ? 0 : duration;

					let title = null;
					if (media.youTubeApi) {
						try { title = media.youTubeApi.getVideoData().title || null; } catch (e) {}
						startAdSkipper(media);
					}

					if (media.twitchPlayer) {
						acceptTwitchWarning(media);
					}

					if (!S.metaSent) {
						S.metaSent = true;
						post('duiMeta', { h: HANDLE, mediaId: mediaId, duration: live ? 0 : duration, live: live, title: title });
					}

					if (!live && startAt > 0) {
						try { media.setCurrentTime(Math.min(startAt, duration - 0.5)); } catch (e) {}
					}

					applyTime();
					applyMix();
				};

				media.addEventListener('canplay', onReady);
				media.addEventListener('loadedmetadata', () => {
					// Some renderers never fire canplay before play().
					setTimeout(onReady, 1500);
				});

				media.addEventListener('playing', () => {
					setLoading(false);
					buildGraph();
					applyVisual();
					applyMix();
				});

				media.addEventListener('waiting', () => {
					if (!S.paused) setLoading(true);
				});

				try {
					const p = media.play();
					if (p && p.catch) p.catch(() => {});
				} catch (e) {}
			}
		});
	}

	function fail(mediaId, message) {
		if (mediaId !== S.mediaId) return;
		post('duiError', { h: HANDLE, mediaId: mediaId, message: String(message) });
	}

	function startAdSkipper(media) {
		if (S.adTimer) clearInterval(S.adTimer);
		S.adTimer = setInterval(() => {
			const doc = iframeDocument(media);
			if (!doc) return;
			const button = doc.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
			if (button) {
				try { button.click(); } catch (e) {}
			}
		}, 1000);
	}

	function acceptTwitchWarning(media) {
		let tries = 0;
		const timer = setInterval(() => {
			tries++;
			const doc = iframeDocument(media);
			const button = doc && doc.querySelector('button[data-a-target="player-overlay-mature-accept"], button[data-a-target="content-classification-gate-overlay-start-watching-button"]');
			if (button) {
				try { button.click(); } catch (e) {}
				clearInterval(timer);
			}
			if (tries > 20) clearInterval(timer);
		}, 500);
	}

	/* ----------------------------------------------------------------- time */

	function setTarget(offset) {
		S.target = Number(offset) || 0;
		S.targetAt = performance.now();
	}

	function currentExpected() {
		let t = S.target;
		if (!S.paused && S.serverReady) {
			t += (performance.now() - S.targetAt) / 1000;
		}
		if (S.duration > 0) {
			t = S.loop ? t % S.duration : Math.min(t, S.duration);
		}
		return Math.max(0, t);
	}

	function applyTime() {
		const media = S.media;
		if (!media) return;

		if (!S.serverReady) {
			// Hold still (silently) until the server says go.
			if (S.metaSent && !media.paused) {
				try { media.pause(); } catch (e) {}
			}
			return;
		}

		if (S.live) {
			if (media.paused) {
				try { media.play(); } catch (e) {}
			}
			return;
		}

		const expected = currentExpected();
		const current = Number(media.currentTime) || 0;

		if (Math.abs(current - expected) > MAX_DRIFT) {
			try { media.setCurrentTime(expected); } catch (e) {}
		}

		if (S.paused) {
			if (!media.paused) {
				try { media.pause(); } catch (e) {}
			}
		} else if (media.paused) {
			try {
				const p = media.play();
				if (p && p.catch) p.catch(() => {});
			} catch (e) {}
		}
	}

	/* ------------------------------------------------------------- messages */

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') return;

		switch (msg.type) {
			case 'load':
				load(msg);
				break;

			case 'settings':
				S.filter = !!msg.filter;
				S.visualization = msg.visualization || false;
				S.visOptions = msg.visualizationOptions || null;
				S.showVideo = msg.showVideo !== false;
				wireGraph();
				applyVisual();
				break;

			case 'time':
				S.serverReady = !!msg.ready;
				S.paused = !!msg.paused;
				S.loop = !!msg.loop;
				if (msg.duration === false) {
					S.live = true;
				} else if (msg.duration > 0) {
					S.duration = msg.duration;
				}
				setTarget(msg.offset);
				applyTime();
				break;

			case 'mix':
				S.volume = Math.max(0, Math.min(1, Number(msg.volume) || 0));
				S.pan = Math.max(-1, Math.min(1, Number(msg.pan) || 0));
				applyMix();
				break;

			case 'stop':
				destroy();
				break;
		}
	});

	window.addEventListener('load', () => {
		requestAnimationFrame(renderVisual);
		post('duiReady', { h: HANDLE });
	});
})();
