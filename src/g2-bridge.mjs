/** Device adapter. The bridge is injected so lifecycle/gesture logic is testable. */
export class G2Bridge {
  constructor(bridge, { onGesture = () => {}, onAudio = () => {}, onError = () => {} } = {}) {
    this.bridge = bridge;
    this.onGesture = onGesture;
    this.onAudio = onAudio;
    this.onError = onError;
    this.ready = false;
    this.recording = false;
    this.frames = [];
    this.bytes = 0;
    this.queue = Promise.resolve();
  }

  page(content) {
    return { containerTotalNum: 1, textObject: [{
      xPosition: 8, yPosition: 8, width: 560, height: 272,
      containerID: 1, containerName: 'vaultlens', isEventCapture: 1,
      borderWidth: 0, paddingLength: 4, content,
    }] };
  }

  async start(content) {
    if (this.ready) return;
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      if (event.audioEvent) {
        if (!this.recording) return;
        const frame = event.audioEvent.audioPcm;
        if (!(frame instanceof Uint8Array) || frame.byteLength % 2) return;
        if (this.bytes + frame.byteLength > 960000) {
          void this.stopRecording().then(this.onAudio).catch(this.onError);
          return;
        }
        this.frames.push(frame.slice()); this.bytes += frame.byteLength;
        return; // Audio-only events must never be interpreted as a click.
      }
      const input = event.textEvent ?? event.listEvent ?? event.sysEvent;
      if (!input) return;
      const type = input.eventType;
      const gestures = { 0: 'click', 1: 'previous', 2: 'next', 3: 'double', 9: 'hold', 10: 'release' };
      // SDK's documented zero-value compatibility applies only to real input payloads.
      const gesture = gestures[type ?? 0];
      if (gesture) Promise.resolve(this.onGesture(gesture)).catch(this.onError);
    });
    const result = await this.bridge.createStartUpPageContainer(this.page(content));
    if (result !== 0) { this.unsubscribe(); throw new Error(`G2画面を作成できません（${result}）`); }
    this.ready = true;
  }

  display(content) {
    if (!this.ready) return Promise.resolve();
    // Serialize rebuilds so slow BLE responses cannot overwrite a newer page.
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!await this.bridge.rebuildPageContainer(this.page(content))) throw new Error('G2画面更新に失敗しました');
    });
    return this.queue;
  }

  async startRecording() {
    if (!this.ready) throw new Error('先にG2へ接続してください');
    if (this.recording) return;
    this.frames = []; this.bytes = 0; this.recording = true;
    try {
      if (!await this.bridge.audioControl(true, 'glasses')) throw new Error('G2マイクが許可されていません');
      this.timer = setTimeout(() => void this.stopRecording().then(this.onAudio).catch(this.onError), 30000);
    } catch (error) { this.recording = false; this.frames = []; throw error; }
  }

  async stopRecording({ discard = false } = {}) {
    clearTimeout(this.timer);
    const wasRecording = this.recording;
    this.recording = false;
    const frames = this.frames; const size = this.bytes;
    this.frames = []; this.bytes = 0;
    if (wasRecording && !await this.bridge.audioControl(false)) throw new Error('マイク停止を確認できません。Evenアプリを閉じてください');
    if (discard) return new Uint8Array();
    const result = new Uint8Array(size); let offset = 0;
    for (const frame of frames) { result.set(frame, offset); offset += frame.byteLength; }
    return result;
  }

  async rootExit() {
    await this.stopRecording({ discard: true });
    // Must be system confirmation mode 1, never immediate exit mode 0.
    return this.bridge.shutDownPageContainer(1);
  }

  async dispose() {
    try { await this.stopRecording({ discard: true }); }
    finally { this.unsubscribe?.(); this.ready = false; }
  }
}
