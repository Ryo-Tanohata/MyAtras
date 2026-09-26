'use strict';
// Timing for the dissolve between two consecutive observations.
//
// Playback used to swap one observation for the next in a single frame, which reads
// as a flicker rather than as weather moving. This fades the drawn cloud layer of the
// previous observation into the drawn cloud layer of the next one.
//
// What it is not: it does not invent an observation between two observed times. Both
// frames on screen during a dissolve are real observations, and the brightness
// threshold is applied to each of them separately before they are mixed - no
// interpolated brightness is ever passed through the cloud threshold and shown as if
// it had been observed. The timestamp keeps naming the observation being faded to.
//
// The same dissolve, slowed down, carries playback from the last observation back to the
// first, days earlier. Cut, that swap read as the weather jumping; faded over seconds, with
// the page saying where it is going, it reads as what it is - going back.
(function (root) {
  class ObservationFade {
    constructor(duration = 380) {
      this.duration = duration;
      this.enabled = true;
      this.started = 0;
      this.progress = 1;
      this.length = duration;
    }

    // Begin a dissolve towards the observation that has just been loaded. The first
    // observation has nothing to fade from, so callers pass hasPrevious = false and
    // it appears at once.
    // duration, when given, holds for this dissolve only: the slow return to the first
    // observation, which smoothing switched off does not skip - it is not a dissolve
    // between neighbours but the page going back, and cut it is a jump.
    start(now, hasPrevious = true, duration) {
      this.started = now;
      const back = duration > 0;
      this.length = back ? duration : this.duration;
      this.progress = (this.enabled || back) && hasPrevious && this.length > 0 ? 0 : 1;
      return this.progress;
    }

    // How far the dissolve has run, 0 (previous observation) to 1 (the new one).
    value(now) {
      if (this.progress >= 1) return 1;
      if (this.length <= 0) {
        this.progress = 1;
        return 1;
      }
      const elapsed = now - this.started;
      this.progress = elapsed <= 0 ? 0 : Math.min(1, elapsed / this.length);
      return this.progress;
    }

    get active() {
      return this.progress < 1;
    }

    // A dissolve must finish before the next observation arrives, or frames pile up
    // and the globe never settles on one observation. Playback intervals run from
    // 300 ms to 1200 ms.
    matchInterval(interval) {
      if (!(interval > 0)) return this.duration;
      this.duration = Math.max(120, Math.min(380, interval * 0.55));
      return this.duration;
    }

    // Turning it off finishes whatever is running rather than freezing it half way.
    setEnabled(value) {
      this.enabled = !!value;
      if (!this.enabled) this.progress = 1;
      return this.enabled;
    }
  }

  root.ObservationFade = ObservationFade;
  if (typeof module !== 'undefined') module.exports = { ObservationFade };
})(typeof window === 'undefined' ? globalThis : window);
