using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Which stored observation is on the globe, and how far the dissolve into it has
    /// run. The timing follows the JavaScript version (dist/weather-playback.js and
    /// dist/observation-fade.js) so both show the sequence the same way:
    ///
    /// - one observation every 0.65 s, the "standard" speed there;
    /// - the newest observation held twice as long before the sequence starts over;
    /// - a dissolve of 0.55 of the interval, kept between 0.12 s and 0.38 s, so it
    ///   always ends before the next observation arrives.
    ///
    /// What is dissolved is two real observations. Nothing here produces an image for a
    /// time between two observed times, and the index always names the observation
    /// being faded to. Going back from the newest observation to the oldest is a jump
    /// of twelve hours, not weather moving, so that step is never dissolved.
    /// </summary>
    public sealed class ObservationPlayback
    {
        public const float StandardInterval = 0.65f;

        public int Count { get; }
        public int Current { get; private set; }
        public int Previous { get; private set; }
        public bool Playing { get; private set; } = true;
        public bool Dissolve { get; set; } = true;
        public float Interval { get; set; } = StandardInterval;

        float nextStep;
        float fadeStarted;
        float fadeDuration;

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
            bool startingOver = Current == 0;
            fadeStarted = now;
            fadeDuration = Dissolve && !startingOver
                ? Mathf.Clamp(Interval * 0.55f, 0.12f, 0.38f)
                : 0f;
            nextStep = now + Hold();
        }

        /// <summary>0 shows the previous observation, 1 the current one.</summary>
        public float Fade(float now)
        {
            if (fadeDuration <= 0f) return 1f;
            return Mathf.Clamp01((now - fadeStarted) / fadeDuration);
        }

        /// <summary>
        /// Puts a chosen observation up at once and pauses there. A hand on the time
        /// slider is not playback, and a jump of hours is not weather moving, so nothing
        /// is dissolved.
        /// </summary>
        public void Show(int index, float now)
        {
            if (Count == 0) return;
            Current = Previous = Mathf.Clamp(index, 0, Count - 1);
            fadeDuration = 0f;
            Playing = false;
            nextStep = now + Hold();
        }

        public void SetPlaying(bool playing, float now)
        {
            if (Playing == playing) return;
            Playing = playing;
            // Resuming waits a full interval, so the observation that was paused on is
            // seen before the next one replaces it.
            if (playing) nextStep = now + Hold();
            // Pausing finishes a dissolve rather than freezing on a mixture.
            else fadeDuration = 0f;
        }
    }
}
