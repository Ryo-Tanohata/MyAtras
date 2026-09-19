using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Which stored observation is on the globe, and how far the change into it has run.
    ///
    /// Two ways of going from one observation to the next:
    ///
    /// - The model (the default): the whole interval is the change. The shader carries
    ///   the earlier observation forward and the later one back with the wind and
    ///   crossfades them over the full interval, so the clouds move continuously and the
    ///   globe arrives on each real observation exactly as the next step begins. Pausing
    ///   holds the globe where it is, part way between two observations.
    /// - Observations only: the timing of the JavaScript version (dist/weather-playback.js
    ///   and dist/observation-fade.js) - a dissolve of 0.55 of the interval, kept between
    ///   0.12 s and 0.38 s, so it always ends before the next observation arrives.
    ///
    /// Either way: one observation every 0.65 s at the "standard" speed, the newest held
    /// twice as long before the sequence starts over, and the index always names the
    /// observation being moved towards. Going back from the newest observation to the
    /// oldest jumps back across the whole sequence, which is not weather moving, so that
    /// step is never dissolved or carried.
    /// </summary>
    public sealed class ObservationPlayback
    {
        public const float StandardInterval = 0.65f;

        public int Count { get; }
        public int Current { get; private set; }
        public int Previous { get; private set; }
        public bool Playing { get; private set; } = true;
        public bool Dissolve { get; set; } = true;
        public bool Model { get; set; } = true;
        public float Interval { get; set; } = StandardInterval;

        /// <summary>True while the change into Current follows on from Previous - not on the step back to the start.</summary>
        public bool Continuing { get; private set; }

        float nextStep;
        float fadeStarted;
        float fadeDuration;
        float heldFade = -1f;

        public ObservationPlayback(int count, float now)
        {
            Count = Mathf.Max(0, count);
            nextStep = now + Hold();
        }

        /// <summary>The newest observation stays up twice as long before starting over.</summary>
        float Hold()
        {
            return Current == Count - 1 ? Interval * 2f : Interval;
        }

        public void Tick(float now)
        {
            if (!Playing || Count < 2 || now < nextStep) return;

            Previous = Current;
            Current = (Current + 1) % Count;
            Continuing = Current != 0;
            fadeStarted = now;
            heldFade = -1f;
            // The model moves over the time until the next step; the step into the newest
            // observation is followed by a double hold, but the move into it still takes
            // one interval, so the globe rests on the real newest observation for the rest.
            fadeDuration = !Continuing ? 0f
                : Model ? Interval
                : Dissolve ? Mathf.Clamp(Interval * 0.55f, 0.12f, 0.38f)
                : 0f;
            nextStep = now + Hold();
        }

        /// <summary>0 shows the previous observation, 1 the current one.</summary>
        public float Fade(float now)
        {
            if (heldFade >= 0f) return heldFade;
            if (fadeDuration <= 0f) return 1f;
            return Mathf.Clamp01((now - fadeStarted) / fadeDuration);
        }

        /// <summary>
        /// Puts a chosen observation up at once and pauses there. A hand on the time
        /// slider is not playback, and a jump of hours is not weather moving, so nothing
        /// is dissolved or carried.
        /// </summary>
        public void Show(int index, float now)
        {
            if (Count == 0) return;
            Current = Previous = Mathf.Clamp(index, 0, Count - 1);
            Continuing = false;
            fadeDuration = 0f;
            heldFade = -1f;
            Playing = false;
            nextStep = now + Hold();
        }

        public void SetPlaying(bool playing, float now)
        {
            if (Playing == playing) return;
            Playing = playing;
            if (playing)
            {
                if (heldFade >= 0f && fadeDuration > 0f)
                {
                    // The model carries on from where it was held, and the next step comes
                    // when that move is finished.
                    fadeStarted = now - heldFade * fadeDuration;
                    nextStep = fadeStarted + Hold();
                }
                else
                {
                    // Resuming waits a full interval, so the observation that was paused on
                    // is seen before the next one replaces it.
                    nextStep = now + Hold();
                }
                heldFade = -1f;
                return;
            }

            if (Model && fadeDuration > 0f)
            {
                // The model holds the globe where it is, part way between two observations.
                heldFade = Fade(now);
            }
            else
            {
                // A dissolve is finished rather than frozen on a mixture.
                fadeDuration = 0f;
            }
        }
    }
}
