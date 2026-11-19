// The test page library ships no types and none are installed here; this is the small part the setup file uses.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    window: Window & typeof globalThis;
  }
}
