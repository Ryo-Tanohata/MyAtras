'use strict';
// The close-up: the same observations SSEC served for the globe, cropped to one part
// of the world at the resolution the server actually holds.
//
// The global frames are 512 pixels for the whole Earth, about 63 km to a pixel at
// Japan, so zooming in turns the clouds into squares. A crop of the same observation
// at the same time carries the detail that was always there; nothing is sharpened,
// interpolated or generated. Each frame is several times the bytes of a global one,
// so they are fetched only when someone asks for them, and a time with no crop keeps
// showing the global frame rather than a stand-in.
(function (root) {
  const POOL = 4;

  class DetailLayer {
    constructor() {
      this.describing = null;
      this.manifest = null;
      this.images = new Map();   // time -> HTMLImageElement
      this.enabled = false;
      this.loading = false;
      this.failed = 0;
      this.onChange = null;
    }

    /// What is bundled, or null when nothing is. Read once.
    describe() {
      if (this.describing) return this.describing;
      this.describing = (async () => {
        const data = root.GeoData ? await root.GeoData.region() : null;
        if (!data || !Array.isArray(data.frames) || !data.frames.length) return null;
        this.manifest = data;
        return data;
      })().catch(() => null);
      return this.describing;
    }

    get times() {
      return this.manifest ? this.manifest.frames.map(f => f.time) : [];
    }

    /// Megabytes the crop adds, for the page to say before it is asked for.
    get megabytes() {
      if (!this.manifest) return 0;
      return this.manifest.frames.reduce((sum, f) => sum + (f.bytes || 0), 0) / (1024 * 1024);
    }

    get ready() {
      return this.images.size;
    }

    /// The crop for an observation time, or null - which means the globe keeps the
    /// global frame for that time.
    imageFor(time) {
      return this.enabled ? this.images.get(time) || null : null;
    }

    changed() {
      if (this.onChange) this.onChange(this);
    }

    async setEnabled(on) {
      this.enabled = !!on;
      this.changed();
      if (this.enabled) await this.load();
    }

    /// Fetches every crop that is not in hand yet, a few at a time so a phone is not
    /// asked for a dozen connections at once. Failures are counted and left out; the
    /// globe then shows the global frame for those times.
    async load() {
      const manifest = await this.describe();
      if (!manifest || this.loading) return;
      const missing = manifest.frames.filter(f => !this.images.has(f.time));
      if (!missing.length) return;
      this.loading = true;
      this.changed();
      let next = 0;
      const worker = async () => {
        while (next < missing.length && this.enabled) {
          const frame = missing[next++];
          try {
            this.images.set(frame.time, await this.image(frame.url));
          } catch (error) {
            this.failed++;
          }
          this.changed();
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(POOL, missing.length) }, worker));
      } finally {
        this.loading = false;
        this.changed();
      }
    }

    image(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('close-up image failed: ' + url));
        image.src = url;
      });
    }

    /// The box in the coordinates the globe shader samples the global frames in.
    box() {
      if (!this.manifest || !root.RegionBox) return null;
      const b = this.manifest.bounds;
      return root.RegionBox.box({ ...b, width: this.manifest.width });
    }
  }

  root.DetailLayer = DetailLayer;
  if (typeof module !== 'undefined') module.exports = { DetailLayer };
})(typeof window === 'undefined' ? globalThis : window);
