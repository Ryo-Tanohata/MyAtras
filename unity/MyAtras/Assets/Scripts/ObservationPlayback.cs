using System;
using System.Collections.Generic;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Which stored observation is on the globe, and how far the change into it has run.
    ///
    /// Two ways of going from one observation to the next:
    ///
    /// - The model (the default): the whole interval is the change. The shader carries
    ///   the earlier observation forward and the later one back and crossfades them over
    ///   the full interval, so the clouds move continuously and the globe arrives on each
    ///   real observation exactly as the next step begins. Pausing holds the globe where
    ///   it is, part way between two observations.
    /// - Observations only: the timing of the JavaScript version (dist/weather-playback.js
    ///   and dist/observation-fade.js) - a dissolve of 0.55 of the interval, kept between
    ///   0.12 s and 0.38 s, so it always ends before the next observation arrives - over
    ///   every stored observation, the newest held twice as long before the sequence
    ///   starts over with a cut: going back days is not weather moving.
    ///
    /// The model loops without a cut. It plays a window of a whole number of days - 48
    /// hours of the bundled three - and hands its end over to its start by overlaying
    /// them: for the first <see cref="Seam"/> steps of the loop, the observations that
    /// follow the window's end are carried on as usual and faded out while the window's
    /// own start is carried on and faded in. Both go forward in time throughout, so the
    /// clouds keep moving while one day's sky gives way to another's; and because the
    /// window is whole days, the two overlaid times are at the same hour of the day and
    /// the sun stays where it was. The page says when two days are overlaid. The oldest
    /// observations before the window are not part of the loop.
    ///
    /// The index always names the main observation being moved towards.
    /// </summary>
    public sealed class ObservationPlayback
    {
        public const float StandardInterval = 0.65f;
        /// <summary>Hours over which the end of the loop is handed over to its start.</summary>
        public const double SeamHours = 12.0;

        public int Count { get; }
        public int Current { get; private set; }
        public int Previous { get; private set; }
        public bool Playing { get; private set; } = true;
        public bool Dissolve { get; set; } = true;
        public bool Model { get; set; } = true;
        public float Interval { get; set; } = StandardInterval;

        /// <summary>The model's loop: its first observation, and its length in steps (whole days).</summary>
        public int LoopStart { get; }
        public int LoopLength { get; }
        /// <summary>Steps over which the loop's end is overlaid on its start; 0 when the stored
        /// observations are too few or uneven to loop whole days.</summary>
        public int Seam { get; }

        /// <summary>True while the change into Current follows on from Previous - not on the step back to the start.</summary>
        public bool Continuing { get; private set; }

        float nextStep;
        float fadeStarted;
        float fadeDuration;
        float heldFade = -1f;
        bool overlayActive;

        public ObservationPlayback(IReadOnlyList<DateTime> times, float now)
        {
            Count = times?.Count ?? 0;
            (LoopStart, LoopLength, Seam) = LoopWindow(times);
            // The model starts just after the seam, on a single real observation.
            Current = Previous = Seam > 0 ? LoopStart + Seam : 0;
            nextStep = now + Hold();
        }

        /// <summary>
        /// The longest window of whole days that leaves <see cref="SeamHours"/> of
        /// observations after it to hand over with, ending at the newest observation.
        /// </summary>
        static (int start, int length, int seam) LoopWindow(IReadOnlyList<DateTime> times)
        {
            int count = times?.Count ?? 0;
            if (count < 3) return (0, count, 0);
            double step = (times[1] - times[0]).TotalHours;
            if (step <= 0) return (0, count, 0);
            for (int i = 2; i < count; i++)
            {
                // Evenly spaced, or the overlaid pair would not be the same hour of the day.
                if (Math.Abs((times[i] - times[i - 1]).TotalHours - step) > 0.01) return (0, count, 0);
            }
            double perDay = 24.0 / step;
            int stepsPerDay = (int)Math.Round(perDay);
            if (Math.Abs(perDay - stepsPerDay) > 1e-6 || stepsPerDay < 1) return (0, count, 0);
            int seam = Math.Max(1, (int)Math.Round(SeamHours / step));
            int length = (count - seam) / stepsPerDay * stepsPerDay;
            if (length < stepsPerDay || length < 2 * seam) return (0, count, 0);
            return (count - length - seam, length, seam);
        }

        bool Looping => Model && Seam > 0;

        /// <summary>Steps into the model's loop, 0 at its start.</summary>
        int LoopStep => Current - LoopStart;

        /// <summary>The newest observation stays up twice as long before a cut back to the start.</summary>
        float Hold()
        {
            return !Looping && Current == Count - 1 ? Interval * 2f : Interval;
        }

        public void Tick(float now)
        {
            if (!Playing || Count < 2 || now < nextStep) return;

            if (Looping)
            {
                int next = Current + 1;
                if (next < LoopStart || next >= LoopStart + LoopLength) next = LoopStart;
                // At the loop's start the main pair comes from the observation before it,
                // faded in under the overlay; the overlay carries on from where the loop was.
                Current = next;
                Previous = next == LoopStart ? Math.Max(0, next - 1) : next - 1;
                Continuing = Previous == Current - 1;
                overlayActive = LoopStep < Seam;
                fadeDuration = Interval;
            }
            else
            {
                Previous = Current;
                Current = (Current + 1) % Count;
                Continuing = Current != 0;
                overlayActive = false;
                fadeDuration = !Continuing ? 0f
                    : Model ? Interval
                    : Dissolve ? Mathf.Clamp(Interval * 0.55f, 0.12f, 0.38f)
                    : 0f;
            }
            fadeStarted = now;
            heldFade = -1f;
            nextStep = now + Hold();
        }

        /// <summary>0 shows the previous observation, 1 the current one.</summary>
        public float Fade(float now)
        {
            if (heldFade >= 0f) return heldFade;
            if (fadeDuration <= 0f) return 1f;
            return Mathf.Clamp01((now - fadeStarted) / fadeDuration);
        }

        /// <summary>True while the loop's end is overlaid on its start.</summary>
        public bool Overlaid => Looping && overlayActive && LoopStep >= 0 && LoopStep < Seam;

        /// <summary>The overlaid pair: the observations that follow the loop's end, one day's
        /// worth of steps on from the main pair.</summary>
        public int OverlayCurrent => Current + LoopLength;
        public int OverlayPrevious => Current + LoopLength - 1;

        /// <summary>
        /// How much of the overlaid pair shows: 1 at the loop's start, handing over smoothly
        /// to 0 by the end of the seam.
        /// </summary>
        public float OverlayWeight(float now)
        {
            if (!Overlaid) return 0f;
            float t = (LoopStep + Fade(now)) / Seam;
            return 1f - Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(t));
        }

        /// <summary>The observation that mostly shows, for the page's timestamp.</summary>
        public int Shown(float now)
        {
            return OverlayWeight(now) > 0.5f ? OverlayCurrent : Current;
        }

        /// <summary>
        /// Puts a chosen observation up at once and pauses there. A hand on the time
        /// slider is not playback, and a jump of hours is not weather moving, so nothing
        /// is dissolved, carried or overlaid.
        /// </summary>
        public void Show(int index, float now)
        {
            if (Count == 0) return;
            Current = Previous = Mathf.Clamp(index, 0, Count - 1);
            Continuing = false;
            overlayActive = false;
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
