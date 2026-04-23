// Base adapter stub (shared by all social platform stubs).
// 完整实现随 ef76ab8 提交漏 commit，这里提供最小接口让 server.mjs 不 crash。
export class StubAdapter {
  constructor(platform) {
    this.platform = platform;
    this._running = false;
  }
  getStatus() {
    return { platform: this.platform, running: false, stub: true };
  }
  async start() {
    throw new Error(`${this.platform} adapter stub: start not implemented`);
  }
  async stop() {
    this._running = false;
  }
  async send() {
    throw new Error(`${this.platform} adapter stub: send not implemented`);
  }
  async verifyWebhook() {
    return { ok: false, error: "stub" };
  }
}
