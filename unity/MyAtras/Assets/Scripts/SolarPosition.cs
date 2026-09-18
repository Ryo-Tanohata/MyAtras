using System;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Where the sun is overhead at a given moment: the subsolar point.
    ///
    /// The Astronomical Almanac's low-precision formulas for the sun and for Greenwich
    /// mean sidereal time, good to about 0.01 degree between 1950 and 2050. Checked in
    /// Assets/Editor/SolarPositionCheck.cs against the 2026 equinoxes (declination 0) and
    /// June solstice (23.44), and against an independent method - NOAA's fractional-year
    /// series - which agrees on longitude within 0.03 degree. That series was not used: it
    /// is off by about 0.4 degree of declination near the equinoxes, which is where the
    /// bundled observations sit.
    /// </summary>
    public static class SolarPosition
    {
        static readonly DateTime J2000 = new DateTime(2000, 1, 1, 12, 0, 0, DateTimeKind.Utc);

        /// <summary>Latitude and longitude of the subsolar point, in degrees; east positive.</summary>
        public static Vector2 Subsolar(DateTime utc)
        {
            double n = (utc.ToUniversalTime() - J2000).TotalDays;
            double meanLongitude = Wrap360(280.460 + 0.9856474 * n);
            double meanAnomaly = Radians(Wrap360(357.528 + 0.9856003 * n));
            double eclipticLongitude = Radians(meanLongitude
                + 1.915 * Math.Sin(meanAnomaly) + 0.020 * Math.Sin(2 * meanAnomaly));
            double obliquity = Radians(23.439 - 0.0000004 * n);

            double rightAscension = Degrees(Math.Atan2(
                Math.Cos(obliquity) * Math.Sin(eclipticLongitude), Math.Cos(eclipticLongitude)));
            double declination = Degrees(Math.Asin(Math.Sin(obliquity) * Math.Sin(eclipticLongitude)));
            double longitude = Wrap180(rightAscension - GreenwichSiderealDegrees(utc));
            return new Vector2((float)declination, (float)longitude);
        }

        /// <summary>
        /// Greenwich mean sidereal time, in degrees: the right ascension overhead at
        /// longitude 0. The stars behind the globe are turned by it, since a direction with
        /// right ascension a lies over longitude a minus this.
        /// </summary>
        public static double GreenwichSiderealDegrees(DateTime utc)
        {
            double n = (utc.ToUniversalTime() - J2000).TotalDays;
            return Wrap360(280.46061837 + 360.98564736629 * n);
        }

        /// <summary>
        /// The same point as a unit vector in the globe shader's frame: y towards the north
        /// pole, and longitude measured as atan2(x, z) - the frame the shader samples the
        /// ground texture in, so a dot product with the surface point gives the sun's
        /// elevation.
        /// </summary>
        public static Vector3 Direction(Vector2 subsolar)
        {
            float lat = subsolar.x * Mathf.Deg2Rad;
            float lon = subsolar.y * Mathf.Deg2Rad;
            return new Vector3(Mathf.Cos(lat) * Mathf.Sin(lon), Mathf.Sin(lat), Mathf.Cos(lat) * Mathf.Cos(lon));
        }

        static double Radians(double degrees) => degrees * Math.PI / 180.0;
        static double Degrees(double radians) => radians * 180.0 / Math.PI;
        static double Wrap360(double degrees) => ((degrees % 360.0) + 360.0) % 360.0;
        static double Wrap180(double degrees) => Wrap360(degrees + 180.0) - 180.0;
    }
}
