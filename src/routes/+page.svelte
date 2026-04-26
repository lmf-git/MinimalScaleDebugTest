<script>
	import { onMount } from 'svelte';
	import Logo from '../Logo.svelte';

	// USB
	let allUsbDevices    = $state([]);
	let usbNotifications = $state([]);

	// Serial
	let serialPorts        = $state([]);
	let selectedPort       = $state('');
	let selectedBaudRate   = $state('9600');
	let serialStatus       = $state('Idle');
	let serialLogs         = $state([]);
	let isSerialConnected  = $state(false);
	let logFilePath        = $state('');
	let copied             = $state(false);

	// Auto-detect
	let autoDetecting      = $state(false);
	let autoDetectProgress = $state(0);
	let autoDetectResult   = $state('');

	// Scale identification (derived from received data)
	let detectedScale = $state(null);

	// Help panel
	let showHelp = $state(false);

	const BAUD_RATES = ['1200','2400','4800','9600','19200','38400','57600','115200'];

	// --- Scale protocol identification ---
	function identifyScale(logs) {
		const sample = logs.slice(0, 40).map(l => l.text).join('\n');

		if (/\bS\s+[SI]\b/.test(sample) || /^T\s+[+-]/.test(sample))
			return { name: 'Mettler-Toledo / Ohaus / Kern', protocol: 'SICS MT',
				confidence: 'high', defaultBaud: '9600',
				tip: 'Send "SIR\\r\\n" for continuous output, "SI\\r\\n" for a single reading' };

		if (/[SU][TDQ],GS/.test(sample))
			return { name: 'A&D Weighing', protocol: 'A&D Standard',
				confidence: 'high', defaultBaud: '9600',
				tip: 'Enable Continuous Output mode in the scale\'s COM menu' };

		if (/^[WN]\d{5}/m.test(sample))
			return { name: 'Avery Berkel / Digi', protocol: 'Continuous stream',
				confidence: 'medium', defaultBaud: '9600',
				tip: 'Check scale COM settings for baud rate and output format' };

		if (/[+-]?\s*\d+[.,]\d+\s*(kg|g\b|lb|oz)/i.test(sample))
			return { name: 'Unknown brand', protocol: 'Weight data stream',
				confidence: 'low', defaultBaud: null,
				tip: 'Receiving weight values — check scale manual for protocol details' };

		return null;
	}

	$effect(() => {
		if (serialLogs.length === 0) { detectedScale = null; return; }
		if (!detectedScale && serialLogs.length >= 3)
			detectedScale = identifyScale(serialLogs);
	});

	// --- Event type detection (Ohaus SICS, A&D, Avery Berkel, generic) ---
	function detectEventType(text) {
		if (!text) return 'data';
		const u = text.toUpperCase();
		if (/S\s+S/.test(text) || u.includes('ST,GS') || /^ST[,\s\r\n]/.test(text)) return 'stable';
		if (/S\s+I/.test(text) || u.includes('UD,GS') || u.includes('QT,GS') || /\bUS\b/.test(u)) return 'motion';
		if (/\bOL\b/.test(u) || u.includes('----') || u.includes('OVERLOAD')) return 'overload';
		if (/^T\s/.test(text) || /^TA[,\s]/.test(text)) return 'tare';
		return 'data';
	}

	function formatTime(iso) {
		const d = new Date(iso);
		return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
	}

	function colorizeHex(hex) {
		if (!hex) return '<span class="hex-empty">—</span>';
		return hex.split(' ').map(b => {
			const v = parseInt(b, 16);
			let cls = '';
			if (v === 0x0d || v === 0x0a) cls = 'hx-crlf';
			else if (v < 0x20 || v === 0x7f) cls = 'hx-ctrl';
			else if (v >= 0x30 && v <= 0x39) cls = 'hx-digit';
			return cls ? `<span class="${cls}">${b}</span>` : b;
		}).join(' ');
	}

	// --- Data management ---
	async function refreshData() {
		allUsbDevices = await window.usbAPI.listDevices();
		serialPorts   = await window.serialAPI.listPorts();
		if (serialPorts.length > 0 && !selectedPort) selectedPort = serialPorts[0].path;
	}

	function addUsbNotification(message, type) {
		const id = Math.random();
		usbNotifications = [...usbNotifications, { id, message, type }];
		setTimeout(() => { usbNotifications = usbNotifications.filter(n => n.id !== id); }, 4000);
	}

	onMount(async () => {
		await refreshData();
		logFilePath = await window.serialAPI.getLogPath();

		window.serialAPI.onDetectProgress((baud) => { autoDetectProgress = baud; });

		window.usbAPI.onAttach((device) => {
			allUsbDevices = [...allUsbDevices, device];
			addUsbNotification(`Attached: VID 0x${device.vendorId.toString(16).padStart(4,'0')} PID 0x${device.productId.toString(16).padStart(4,'0')}`, 'attach');
		});
		window.usbAPI.onDetach((device) => {
			allUsbDevices = allUsbDevices.filter(d =>
				!(d.vendorId === device.vendorId && d.productId === device.productId));
			addUsbNotification(`Removed: VID 0x${device.vendorId.toString(16).padStart(4,'0')}`, 'detach');
		});

		window.serialAPI.onData((entry) => {
			const eventType = entry.eventType === 'disconnect'
				? 'disconnect' : detectEventType(entry.text);
			serialLogs = [{ ...entry, eventType, id: Math.random() }, ...serialLogs].slice(0, 500);
		});
		window.serialAPI.onStatus((status) => {
			serialStatus     = status;
			isSerialConnected = status.startsWith('Connected');
		});
	});

	function toggleSerial() {
		if (isSerialConnected) window.serialAPI.closePort();
		else window.serialAPI.openPort(selectedPort, selectedBaudRate);
	}

	async function autoDetectBaud() {
		if (isSerialConnected || autoDetecting || !selectedPort) return;
		autoDetecting      = true;
		autoDetectProgress = 0;
		autoDetectResult   = '';

		const res = await window.serialAPI.autoDetect(selectedPort);
		autoDetecting = false;

		if (res.baud) {
			selectedBaudRate = String(res.baud);
			autoDetectResult = `✓ ${res.baud}`;
		} else {
			autoDetectResult = 'Not found';
		}
		setTimeout(() => { autoDetectResult = ''; autoDetectProgress = 0; }, 4000);
	}

	function clearLogs() { serialLogs = []; }

	function copyAllLogs() {
		const text = [...serialLogs].reverse()
			.map(e => `[${e.timestamp}] ${e.eventType.toUpperCase().padEnd(10)} HEX: ${(e.hex || '').padEnd(48)} | TEXT: ${e.text}`)
			.join('\n');
		navigator.clipboard.writeText(text).then(() => {
			copied = true;
			setTimeout(() => copied = false, 2000);
		});
	}
</script>

<div class="splash">
	<Logo size="260" animated={true} />
</div>

<!-- Toast notifications -->
<div class="notifications">
	{#each usbNotifications as n (n.id)}
		<div class="toast {n.type}">{n.message}</div>
	{/each}
</div>

<main>
	<!-- Header -->
	<header>
		<h1>Scale Debug Monitor</h1>
		<div class="header-actions">
			<button class="btn-sm" onclick={refreshData}>Scan Hardware</button>
			<button class="btn-help" onclick={() => showHelp = true} title="Connection guide">? Help</button>
		</div>
	</header>

	<!-- Connection bar -->
	<div class="conn-bar">
		<select bind:value={selectedPort} disabled={isSerialConnected}>
			{#each serialPorts as p}
				<option value={p.path}>{p.path}{p.friendlyName ? ' — ' + p.friendlyName : ''}</option>
			{/each}
		</select>

		<div class="baud-group">
			<select class="baud-select" bind:value={selectedBaudRate} disabled={isSerialConnected || autoDetecting}>
				{#each BAUD_RATES as b}
					<option value={b}>{b}</option>
				{/each}
			</select>
			<button
				class="btn-autodetect"
				class:scanning={autoDetecting}
				class:found={autoDetectResult.startsWith('✓')}
				class:notfound={autoDetectResult === 'Not found'}
				onclick={autoDetectBaud}
				disabled={isSerialConnected || autoDetecting || !selectedPort}
				title="Try each baud rate and pick the one the scale responds on"
			>
				{#if autoDetecting}
					{autoDetectProgress > 0 ? autoDetectProgress + '…' : 'Scanning…'}
				{:else if autoDetectResult}
					{autoDetectResult}
				{:else}
					Auto-Detect
				{/if}
			</button>
		</div>

		<button class:active={isSerialConnected} onclick={toggleSerial}>
			{isSerialConnected ? 'Disconnect' : 'Connect'}
		</button>
		<div class="status-pill" class:online={isSerialConnected}>
			<span class="dot"></span>
			{serialStatus}
		</div>
	</div>

	<!-- Detected scale bar -->
	{#if detectedScale}
	<div class="scale-bar">
		<span class="scale-icon">⚖</span>
		<span class="scale-name">{detectedScale.name}</span>
		<span class="scale-proto">{detectedScale.protocol}</span>
		<span class="scale-conf conf-{detectedScale.confidence}">{detectedScale.confidence}</span>
		{#if detectedScale.tip}
			<span class="scale-tip">{detectedScale.tip}</span>
		{/if}
	</div>
	{/if}

	<!-- Log file path -->
	{#if logFilePath}
	<div class="logpath-bar">
		<span class="logpath-label">Log file:</span>
		<span class="logpath-value">{logFilePath}</span>
		<button class="btn-sm" onclick={() => window.serialAPI.openLogFolder()}>Open Folder</button>
	</div>
	{/if}

	<div class="dashboard">
		<!-- Serial debug log -->
		<section class="serial-section">
			<div class="section-header">
				<h2>Serial Debug Log <span class="count">({serialLogs.length})</span></h2>
				<div class="log-controls">
					<button class="btn-sm" onclick={clearLogs}>Clear</button>
					<button class="btn-sm" class:success={copied} onclick={copyAllLogs}>
						{copied ? 'Copied!' : 'Copy All'}
					</button>
				</div>
			</div>

			<div class="legend">
				<span class="badge stable">stable</span>
				<span class="badge motion">motion</span>
				<span class="badge overload">overload</span>
				<span class="badge tare">tare</span>
				<span class="badge disconnect">disconnect</span>
				<span class="badge data">data</span>
				<span class="hex-legend">
					<span class="hx-crlf">CR/LF</span>
					<span class="hx-ctrl">CTRL</span>
					<span class="hx-digit">0–9</span>
				</span>
			</div>

			<div class="log-header">
				<span class="col-time">Time</span>
				<span class="col-badge">Event</span>
				<span class="col-hex">Hex (raw bytes)</span>
				<span class="col-text">Decoded text</span>
			</div>

			<div class="log-body">
				{#each serialLogs as entry (entry.id)}
					<div class="log-row {entry.eventType}">
						<span class="col-time">{formatTime(entry.timestamp)}</span>
						<span class="col-badge"><span class="badge {entry.eventType}">{entry.eventType}</span></span>
						<span class="col-hex">{@html colorizeHex(entry.hex)}</span>
						<span class="col-text">{entry.text}</span>
					</div>
				{/each}
				{#if serialLogs.length === 0}
					<div class="empty-state">No data yet. Connect a port and interact with the scale.</div>
				{/if}
			</div>
		</section>

		<!-- USB sidebar -->
		<aside class="usb-section">
			<h2>USB Devices <span class="count">({allUsbDevices.length})</span></h2>
			<div class="usb-list">
				{#each allUsbDevices as d}
					<div class="usb-card">
						<div class="usb-ids">
							<span>VID <code>0x{d.vendorId.toString(16).padStart(4,'0')}</code></span>
							<span>PID <code>0x{d.productId.toString(16).padStart(4,'0')}</code></span>
						</div>
						<div class="usb-sub">Bus {d.busNumber} · Addr {d.deviceAddress}</div>
					</div>
				{/each}
				{#if allUsbDevices.length === 0}
					<div class="empty-state">No USB devices detected.</div>
				{/if}
			</div>
		</aside>
	</div>
</main>

<!-- Help panel -->
{#if showHelp}
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="help-overlay" onclick={() => showHelp = false}></div>
<aside class="help-panel">
	<div class="help-header">
		<h2>Connection Guide</h2>
		<button class="btn-close" onclick={() => showHelp = false}>✕</button>
	</div>
	<div class="help-body">

		<section class="help-section">
			<h3>Quick Start</h3>
			<ol>
				<li>Connect the scale to your PC via a <strong>USB-to-RS-232 adapter</strong> (DB9 female on scale side)</li>
				<li>Click <strong>Scan Hardware</strong>, select the COM port, then click <strong>Auto-Detect</strong> to find the baud rate automatically</li>
				<li>Click <strong>Connect</strong> — weight data will appear in the log and the scale will be identified automatically</li>
			</ol>
		</section>

		<section class="help-section">
			<h3>RS-232 / DB9 Wiring</h3>
			<div class="pinout">
				<div class="pin-row">
					<span class="pin-num">2</span>
					<span class="pin-label">RX — receive data</span>
					<span class="pin-note">← scale TX</span>
				</div>
				<div class="pin-row">
					<span class="pin-num">3</span>
					<span class="pin-label">TX — transmit data</span>
					<span class="pin-note">→ scale RX</span>
				</div>
				<div class="pin-row">
					<span class="pin-num">5</span>
					<span class="pin-label">GND — signal ground</span>
					<span class="pin-note">⏚ common</span>
				</div>
			</div>
			<p class="help-note">Use a straight-through cable. If you get no data, try a <strong>null-modem adapter</strong> (swaps pins 2 &amp; 3). Many scales only need pins 2, 3, and 5.</p>
		</section>

		<section class="help-section">
			<h3>Scale Configuration</h3>
			<p>In the scale's COM / Interface menu, configure:</p>
			<ul>
				<li><strong>Interface:</strong> RS-232</li>
				<li><strong>Baud rate:</strong> 9600 (most common) — or use Auto-Detect</li>
				<li><strong>Data format:</strong> 8N1 (8 data bits, no parity, 1 stop bit)</li>
				<li><strong>Output mode:</strong> Continuous output or print-on-command</li>
				<li><strong>Handshake:</strong> None (RTS/CTS off)</li>
			</ul>
		</section>

		<section class="help-section">
			<h3>Brand Reference</h3>
			<table class="brand-table">
				<thead>
					<tr><th>Brand</th><th>Protocol</th><th>Default baud</th></tr>
				</thead>
				<tbody>
					<tr><td>Mettler-Toledo</td><td>SICS MT</td><td>9600</td></tr>
					<tr><td>Ohaus</td><td>SICS</td><td>9600</td></tr>
					<tr><td>Kern</td><td>SICS-compatible</td><td>9600</td></tr>
					<tr><td>A&amp;D Weighing</td><td>A&amp;D Standard</td><td>9600</td></tr>
					<tr><td>Sartorius</td><td>SBI</td><td>9600</td></tr>
					<tr><td>CAS</td><td>Continuous / Modbus</td><td>9600</td></tr>
					<tr><td>Avery Berkel</td><td>Continuous stream</td><td>9600</td></tr>
					<tr><td>Digi</td><td>Continuous stream</td><td>9600</td></tr>
					<tr><td>Fairbanks</td><td>SAP / Continuous</td><td>9600</td></tr>
					<tr><td>Rice Lake</td><td>Continuous / Custom</td><td>9600</td></tr>
				</tbody>
			</table>
		</section>

		<section class="help-section">
			<h3>Troubleshooting</h3>
			<ul class="trouble-list">
				<li><strong>No data at all</strong> — Check cable; try swapping TX/RX with a null-modem adapter</li>
				<li><strong>Garbled / random characters</strong> — Wrong baud rate; click Auto-Detect</li>
				<li><strong>Port not listed</strong> — Install USB-Serial driver (FTDI, CP210x, or CH340 depending on adapter chip)</li>
				<li><strong>Scale not transmitting</strong> — Enable RS-232 continuous output in the scale's menu; some scales only transmit when the Print key is pressed</li>
				<li><strong>Data arrives in chunks</strong> — Normal; each packet is one weighing line ending in CR+LF</li>
				<li><strong>Access denied on port</strong> — On Linux/macOS, run: <code>sudo usermod -aG dialout $USER</code> then log out and back in</li>
			</ul>
		</section>

	</div>
</aside>
{/if}

<style>
	.splash {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: #020617;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		animation: splash-out 2.8s ease-in-out forwards;
	}

	@keyframes splash-out {
		0%, 78% { opacity: 1; }
		100%     { opacity: 0; }
	}

	:global(body) { font-size: 14px; }

	main {
		padding: 1.5rem;
		max-width: 1400px;
		margin: 0 auto;
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.header-actions { display: flex; gap: 0.5rem; align-items: center; }

	h1 { color: #38bdf8; margin: 0; font-size: 1.25rem; }
	h2 { font-size: 0.95rem; margin: 0; color: #94a3b8; }
	.count { color: #475569; font-weight: normal; }

	/* Connection bar */
	.conn-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: #0f172a;
		border: 1px solid #1e293b;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
		margin-bottom: 0.5rem;
		flex-wrap: wrap;
	}

	select {
		background: #1e293b;
		color: #e2e8f0;
		border: 1px solid #334155;
		padding: 0.35rem 0.5rem;
		border-radius: 0.4rem;
		font-size: 0.8rem;
	}

	select:disabled { opacity: 0.5; }

	.baud-group {
		display: flex;
		align-items: center;
		gap: 0;
		border: 1px solid #334155;
		border-radius: 0.4rem;
		overflow: hidden;
	}

	.baud-group select {
		border: none;
		border-radius: 0;
		width: 90px;
		border-right: 1px solid #334155;
	}

	.btn-autodetect {
		background: #1e293b;
		color: #94a3b8;
		border: none;
		padding: 0.35rem 0.65rem;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		border-radius: 0;
		transition: background 0.15s, color 0.15s;
	}

	.btn-autodetect:hover:not(:disabled) { background: #334155; color: #e2e8f0; }
	.btn-autodetect:disabled { opacity: 0.45; cursor: not-allowed; }
	.btn-autodetect.scanning { color: #fbbf24; animation: pulse 1s ease-in-out infinite; }
	.btn-autodetect.found    { color: #86efac; }
	.btn-autodetect.notfound { color: #f87171; }

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50%       { opacity: 0.5; }
	}

	button {
		background: #0ea5e9;
		color: #0f172a;
		border: none;
		padding: 0.4rem 0.9rem;
		border-radius: 0.4rem;
		font-weight: 600;
		font-size: 0.8rem;
		cursor: pointer;
		white-space: nowrap;
	}

	button.active  { background: #ef4444; color: white; }
	button.success { background: #22c55e; color: #0f172a; }

	.btn-sm {
		background: #1e293b;
		color: #94a3b8;
		padding: 0.3rem 0.65rem;
		font-size: 0.75rem;
		border: 1px solid #334155;
	}
	.btn-sm:hover { background: #334155; color: #e2e8f0; }

	.btn-help {
		background: transparent;
		color: #475569;
		border: 1px solid #334155;
		padding: 0.3rem 0.65rem;
		font-size: 0.75rem;
		border-radius: 0.4rem;
	}
	.btn-help:hover { background: #1e293b; color: #94a3b8; }

	.status-pill {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		color: #64748b;
		margin-left: auto;
	}

	.dot {
		width: 7px; height: 7px;
		border-radius: 50%;
		background: #475569;
		flex-shrink: 0;
	}

	.status-pill.online .dot { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
	.status-pill.online { color: #94a3b8; }

	/* Detected scale bar */
	.scale-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: #0a1628;
		border: 1px solid #1e3a8a;
		border-radius: 0.4rem;
		padding: 0.4rem 0.75rem;
		margin-bottom: 0.5rem;
		font-size: 0.78rem;
		flex-wrap: wrap;
	}

	.scale-icon { font-size: 0.9rem; }
	.scale-name { color: #93c5fd; font-weight: 600; }
	.scale-proto {
		color: #475569;
		background: #1e293b;
		padding: 1px 6px;
		border-radius: 3px;
		font-family: monospace;
		font-size: 0.72rem;
	}

	.scale-conf {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 1px 5px;
		border-radius: 3px;
	}
	.conf-high   { background: #14532d; color: #86efac; }
	.conf-medium { background: #78350f; color: #fde68a; }
	.conf-low    { background: #1e293b; color: #64748b; }

	.scale-tip { color: #64748b; font-size: 0.72rem; font-style: italic; }

	/* Log path bar */
	.logpath-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: #475569;
		margin-bottom: 1rem;
		padding: 0.3rem 0;
	}
	.logpath-label { color: #334155; }
	.logpath-value { font-family: monospace; color: #64748b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	/* Dashboard layout */
	.dashboard {
		display: grid;
		grid-template-columns: 1fr 240px;
		gap: 1rem;
		align-items: start;
	}

	/* Serial section */
	.serial-section {
		background: #0f172a;
		border: 1px solid #1e293b;
		border-radius: 0.75rem;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.log-controls { display: flex; gap: 0.4rem; }

	.legend {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		font-size: 0.7rem;
	}

	.hex-legend {
		display: flex;
		gap: 0.35rem;
		margin-left: 0.5rem;
		font-family: monospace;
		font-size: 0.7rem;
	}

	.log-header {
		display: grid;
		grid-template-columns: 96px 82px 1fr 1fr;
		gap: 6px;
		padding: 4px 8px;
		font-size: 0.7rem;
		color: #475569;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-bottom: 1px solid #1e293b;
	}

	.log-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		height: 520px;
		overflow-y: auto;
	}

	.log-body::-webkit-scrollbar { width: 5px; }
	.log-body::-webkit-scrollbar-track { background: #0a0f1e; }
	.log-body::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }

	.log-row {
		display: grid;
		grid-template-columns: 96px 82px 1fr 1fr;
		gap: 6px;
		padding: 4px 8px;
		border-radius: 4px;
		font-family: monospace;
		font-size: 0.78rem;
		align-items: start;
		background: #080e1a;
		border-left: 2px solid transparent;
	}

	.log-row.stable     { border-left-color: #166534; }
	.log-row.motion     { border-left-color: #92400e; }
	.log-row.overload   { border-left-color: #7f1d1d; background: #1a0505; }
	.log-row.tare       { border-left-color: #1e3a8a; }
	.log-row.disconnect { border-left-color: #6b21a8; background: #12062a; }

	.col-time  { color: #475569; white-space: nowrap; }
	.col-hex   { color: #94a3b8; word-break: break-all; line-height: 1.6; }
	.col-text  { color: #cbd5e1; word-break: break-all; }

	:global(.hx-crlf)  { color: #f87171; }
	:global(.hx-ctrl)  { color: #fb923c; }
	:global(.hx-digit) { color: #86efac; }
	:global(.hex-empty){ color: #334155; }

	.badge {
		display: inline-block;
		padding: 1px 5px;
		border-radius: 3px;
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-family: monospace;
	}

	.badge.stable     { background: #14532d; color: #86efac; }
	.badge.motion     { background: #78350f; color: #fde68a; }
	.badge.overload   { background: #7f1d1d; color: #fca5a5; }
	.badge.tare       { background: #1e3a8a; color: #93c5fd; }
	.badge.disconnect { background: #4a044e; color: #e879f9; }
	.badge.data       { background: #1e293b; color: #64748b; }

	/* USB aside */
	.usb-section {
		background: #0f172a;
		border: 1px solid #1e293b;
		border-radius: 0.75rem;
		padding: 1rem;
	}

	.usb-section h2 { margin-bottom: 0.75rem; }

	.usb-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 620px;
		overflow-y: auto;
	}

	.usb-card {
		background: #1e293b;
		border: 1px solid #334155;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
	}

	.usb-ids { display: flex; flex-direction: column; gap: 2px; font-size: 0.8rem; color: #cbd5e1; }
	.usb-ids code { color: #7dd3fc; font-family: monospace; }
	.usb-sub { font-size: 0.7rem; color: #475569; margin-top: 4px; }

	.empty-state {
		color: #334155;
		font-size: 0.8rem;
		text-align: center;
		padding: 2rem 0;
		font-family: monospace;
	}

	/* Toasts */
	.notifications {
		position: fixed;
		top: 1rem;
		right: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		z-index: 100;
	}

	.toast {
		padding: 0.6rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8rem;
		font-family: monospace;
		box-shadow: 0 8px 24px rgba(0,0,0,0.5);
		animation: slideIn 0.2s ease-out;
	}

	.toast.attach { background: #052e16; color: #bbf7d0; border: 1px solid #166534; }
	.toast.detach { background: #450a0a; color: #fecaca; border: 1px solid #7f1d1d; }

	@keyframes slideIn {
		from { transform: translateX(110%); opacity: 0; }
		to   { transform: translateX(0);   opacity: 1; }
	}

	/* Help panel */
	.help-overlay {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.55);
	}

	.help-panel {
		position: fixed;
		top: 0; right: 0; bottom: 0;
		width: 420px;
		z-index: 201;
		background: #0b1425;
		border-left: 1px solid #1e293b;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		animation: slideInRight 0.2s ease-out;
	}

	@keyframes slideInRight {
		from { transform: translateX(100%); }
		to   { transform: translateX(0); }
	}

	.help-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid #1e293b;
		background: #0b1425;
		flex-shrink: 0;
	}

	.help-header h2 { color: #38bdf8; font-size: 0.9rem; }

	.btn-close {
		background: #1e293b;
		color: #64748b;
		border: none;
		padding: 0.3rem 0.55rem;
		border-radius: 0.3rem;
		font-size: 0.85rem;
		cursor: pointer;
		line-height: 1;
	}
	.btn-close:hover { background: #334155; color: #e2e8f0; }

	.help-body {
		flex: 1;
		overflow-y: auto;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.help-body::-webkit-scrollbar { width: 4px; }
	.help-body::-webkit-scrollbar-track { background: transparent; }
	.help-body::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }

	.help-section h3 {
		font-size: 0.72rem;
		color: #38bdf8;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		margin: 0 0 0.7rem;
	}

	.help-section p,
	.help-section li { font-size: 0.8rem; color: #94a3b8; line-height: 1.65; }

	.help-section ol,
	.help-section ul {
		padding-left: 1.2rem;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.help-section strong { color: #cbd5e1; }
	.help-section code   { color: #7dd3fc; font-family: monospace; font-size: 0.78rem; }

	.pinout {
		background: #060d1a;
		border: 1px solid #1e293b;
		border-radius: 0.4rem;
		padding: 0.6rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-bottom: 0.6rem;
	}

	.pin-row {
		display: grid;
		grid-template-columns: 26px 1fr auto;
		gap: 0.6rem;
		font-size: 0.78rem;
		font-family: monospace;
		align-items: center;
	}

	.pin-num {
		color: #7dd3fc;
		font-weight: bold;
		background: #1e3a8a;
		padding: 1px 5px;
		border-radius: 3px;
		text-align: center;
	}

	.pin-label { color: #e2e8f0; }
	.pin-note  { color: #475569; font-size: 0.7rem; }
	.help-note { font-size: 0.74rem; color: #64748b; font-style: italic; margin: 0; }

	.brand-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
	}

	.brand-table th {
		color: #475569;
		text-align: left;
		padding: 0.3rem 0.5rem;
		border-bottom: 1px solid #1e293b;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.brand-table td {
		color: #94a3b8;
		padding: 0.3rem 0.5rem;
		border-bottom: 1px solid #0d1a2e;
	}

	.brand-table tr:hover td { background: #060d1a; }

	.trouble-list { gap: 0.45rem !important; }
	.trouble-list li { color: #7f92ab; }
	.trouble-list strong { color: #cbd5e1; }
	.trouble-list code   { color: #7dd3fc; font-family: monospace; font-size: 0.76rem; }
</style>
