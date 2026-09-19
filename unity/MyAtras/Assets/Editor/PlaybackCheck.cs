using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Checks <see cref="ObservationPlayback"/>'s loop: the window of whole days, the seam
    /// that hands its end over to its start, and that nothing jumps where it wraps.
    ///
    ///   Unity -batchmode -quit -projectPath unity/MyAtras -executeMethod MyAtras.PlaybackCheck.Run
    ///
    /// Exits 1 on any failure.
    /// </summary>
    public static class PlaybackCheck
    {
        [MenuItem("MyAtras/Check the playback loop")]
        public static void Run()
        {
            int failures = 0;

            // The bundled set: 71 hourly observations.
            var hourly = Times(71, 1);
            var p = new ObservationPlayback(hourly, 0f);
            failures += Check("71 hourly observations loop 48 hours", p.LoopLength == 48, $"length {p.LoopLength}");
            failures += Check("handed over across 12 hours", p.Seam == 12, $"seam {p.Seam}");
            failures += Check("ending at the newest observation", p.LoopStart + p.LoopLength + p.Seam == 71,
                $"start {p.LoopStart}");
            failures += Check("starting just after the seam, on one observation",
                p.Current == p.LoopStart + p.Seam && p.OverlayWeight(0f) == 0f, $"current {p.Current}");
            // Whole days apart: the overlaid pair stands at the same hour of the day.
            TimeSpan apart = hourly[p.LoopStart + p.LoopLength] - hourly[p.LoopStart];
            failures += Check("the overlaid observations are whole days apart", apart.TotalHours % 24 == 0,
                $"{apart.TotalHours} hours");

            // Play to the end of the loop, one step at a time.
            float now = 0f;
            p.Interval = 1f;
            while (p.Current != p.LoopStart + p.LoopLength - 1) { now += 1f; p.Tick(now); }
            int last = p.Current;
            now += 1f;
            p.Tick(now);
            failures += Check("the loop wraps to its start", p.Current == p.LoopStart, $"current {p.Current}");
            failures += Check("where it wraps, the overlaid pair follows on from what was shown",
                p.OverlayPrevious == last && p.OverlayCurrent == last + 1,
                $"{p.OverlayPrevious} -> {p.OverlayCurrent} after {last}");
            failures += Check("and shows entirely at first", Mathf.Approximately(p.OverlayWeight(now), 1f),
                $"weight {p.OverlayWeight(now):F2}");
            failures += Check("the start's own pair follows on too", p.Continuing && p.Previous == p.Current - 1,
                $"{p.Previous} -> {p.Current}");

            // Through the seam, the overlay only ever fades, and is gone at its end.
            float previousWeight = 1f;
            bool fading = true;
            for (int step = 0; step < p.Seam; step++)
            {
                for (float f = 0f; f <= 1f; f += 0.25f)
                {
                    float w = p.OverlayWeight(now + f * p.Interval);
                    if (w > previousWeight + 1e-5f) fading = false;
                    previousWeight = w;
                }
                now += 1f;
                p.Tick(now);
            }
            failures += Check("the overlay only fades through the seam", fading, "");
            failures += Check("and is gone after it", p.OverlayWeight(now) == 0f && !p.Overlaid,
                $"weight {p.OverlayWeight(now):F2}");

            // Three-hourly observations loop whole days too.
            var threeHourly = new ObservationPlayback(Times(24, 3), 0f);
            failures += Check("24 three-hourly observations loop 48 hours over a 12-hour seam",
                threeHourly.LoopLength == 16 && threeHourly.Seam == 4 && threeHourly.LoopStart == 4,
                $"start {threeHourly.LoopStart} length {threeHourly.LoopLength} seam {threeHourly.Seam}");

            // Too few to loop whole days: the old cut, and never an overlay.
            var few = new ObservationPlayback(Times(13, 1), 0f);
            failures += Check("13 hourly observations are too few to loop a day with a seam",
                few.Seam == 0 && few.Current == 0, $"seam {few.Seam}");

            // Observations alone never overlay, and cut back to the very first observation.
            var alone = new ObservationPlayback(hourly, 0f) { Model = false, Interval = 1f };
            float t = 0f;
            bool overlaid = false;
            for (int i = 0; i < 75; i++) { t += 2f; alone.Tick(t); overlaid |= alone.Overlaid; }
            failures += Check("the observations alone are never overlaid", !overlaid, "");

            Debug.Log(failures == 0 ? "MyAtras playback: all checks passed" : $"MyAtras playback: {failures} check(s) failed");
            if (Application.isBatchMode) EditorApplication.Exit(failures == 0 ? 0 : 1);
        }

        static List<DateTime> Times(int count, int hours)
        {
            var times = new List<DateTime>();
            var first = new DateTime(2026, 9, 16, 6, 0, 0, DateTimeKind.Utc);
            for (int i = 0; i < count; i++) times.Add(first.AddHours(i * hours));
            return times;
        }

        static int Check(string label, bool ok, string detail)
        {
            Debug.Log($"MyAtras playback: {(ok ? "ok  " : "FAIL")} {label}{(detail.Length > 0 ? ": " + detail : "")}");
            return ok ? 0 : 1;
        }
    }
}
