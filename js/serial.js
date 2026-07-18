// Minimal Web Serial wrapper. Handles connecting, writing text, and turning
// the incoming byte stream into 'line' events (one complete, newline-
// terminated line each).
//
// PCB1's HMI mode (see "Embedded - fin/TA - PCB1/HMI_PROTOCOL.md") is a
// tagged, fully line-terminated protocol with NO blocking prompts, so unlike
// the earlier draft this wrapper no longer needs to sniff for an
// unterminated ": " prompt tail -- every message in both directions ends in
// '\n'. `js/pcb1-client.js` demuxes the lines by their leading tag.
//
// TextDecoderStream already coalesces/​splits USB packets for us, so the
// bump test's ~11 k-row bulk dump arrives as ordinary line events with no
// special chunk handling needed here (the framing markers #BEGIN/#END that
// bracket it are just lines too, interpreted one layer up in pcb1-client).
export class SerialLink extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this._buffer = '';
  }

  get isOpen() {
    return !!this.port;
  }

  async connect(baudRate = 115200) {
    if (!('serial' in navigator)) {
      throw new Error(
        'Web Serial API is not available in this browser. Use desktop Chrome or Edge, served over http://localhost or https:// (not file://).'
      );
    }
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    this.port = port;
    this._buffer = '';

    const textDecoder = new TextDecoderStream();
    this._readableClosed = port.readable.pipeTo(textDecoder.writable).catch(() => {});
    this.reader = textDecoder.readable.getReader();

    const textEncoder = new TextEncoderStream();
    this._writableClosed = textEncoder.readable.pipeTo(port.writable).catch(() => {});
    this.writer = textEncoder.writable.getWriter();

    this._readLoop();
    this.dispatchEvent(new Event('open'));
  }

  async _readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this._onChunk(value);
      }
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    } finally {
      this.port = null;
      this.dispatchEvent(new Event('close'));
    }
  }

  _onChunk(chunk) {
    this._buffer += chunk;
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop(); // last segment has no trailing \n yet (or is empty)

    for (const rawLine of lines) {
      this.dispatchEvent(new CustomEvent('line', { detail: rawLine.replace(/\r$/, '') }));
    }
  }

  async write(text) {
    if (!this.writer) throw new Error('Serial link is not connected.');
    // Surface what we send, so the on-screen serial log can show both
    // directions (invaluable for debugging the handshake / a command that
    // gets no response). Strip the trailing newline for display, and skip
    // bare-newline flushes (the connect resync sends a lone '\n').
    const shown = text.replace(/\r?\n$/, '');
    if (shown.length) this.dispatchEvent(new CustomEvent('tx', { detail: shown }));
    await this.writer.write(text);
  }

  async disconnect() {
    try { await this.reader?.cancel(); } catch {}
    try { await this.writer?.close(); } catch {}
    try { await this._readableClosed; } catch {}
    try { await this._writableClosed; } catch {}
    try { await this.port?.close(); } catch {}
    this.port = null;
    this.reader = null;
    this.writer = null;
  }
}
