using ContextCross.Utilities;
using GroundAtc.Numerics;
using UnityEngine;
using Vector3 = UnityEngine.Vector3;

namespace AC27Approach;

/// <summary>
/// Unit and coordinate conversions between GroundAtc.Numerics Q32.32 SI types
/// and Unity scene / aviation units expected by the editor and plugin logic.
/// </summary>
internal static class SimUnits
{
    public const double KtToMps = 1852.0 / 3600.0;
    public const double MpsToKt = 3600.0 / 1852.0;
    public const double FtToMetres = 0.3048;
    public const double MetresToFt = 1.0 / 0.3048;

    /// <summary>Position3 (SI metres) → Unity Vector3 in Game Units (1 GU = 100 m).</summary>
    public static Vector3 ToUnityPos(Position3 pos) => UnityNumerics.ToUnity(pos);

    /// <summary>Unity Vector3 in Game Units (1 GU = 100 m) → Position3 (SI metres).</summary>
    public static Position3 ToSimPos(Vector3 gu) => UnityNumerics.ToPosition(gu);

    /// <summary>Direction3 → Unity unit Vector3 (Vector3.zero when invalid).</summary>
    public static Vector3 ToUnityDir(Direction3 dir)
        => dir.IsValid ? UnityNumerics.ToUnity(dir) : Vector3.zero;

    /// <summary>Unity Vector3 → normalized Direction3 (default when near-zero).</summary>
    public static Direction3 ToSimDir(Vector3 dir)
        => dir.sqrMagnitude > 1e-6f ? UnityNumerics.ToDirection(dir.normalized) : default;

    /// <summary>Speed (SI m/s) → knots.</summary>
    public static float ToKnots(Speed s) => (float)(s.MetresPerSecond.ToDouble() * MpsToKt);

    /// <summary>Knots → Speed (SI m/s).</summary>
    public static Speed FromKnots(float kts) => Speed.FromSi(UnityNumerics.ToFixed((double)kts * KtToMps));

    /// <summary>Knots per second → Acceleration (SI m/s²).</summary>
    public static Acceleration FromKnotsPerSec(float ktsPerSec)
        => Acceleration.FromSi(UnityNumerics.ToFixed((double)ktsPerSec * KtToMps));

    /// <summary>Length (SI m) → feet.</summary>
    public static float ToFeet(Length len) => (float)(len.Metres.ToDouble() * MetresToFt);

    /// <summary>Feet → Length (SI m).</summary>
    public static Length FromFeet(float ft) => Length.FromSi(UnityNumerics.ToFixed((double)ft * FtToMetres));

    /// <summary>Length (SI m) → Game Units (1 GU = 100 m).</summary>
    public static float ToGameUnits(Length len) => (float)(len.Metres.ToDouble() * 0.01);

    /// <summary>Velocity3 (SI m/s) magnitude → Game Units per second (1 GU = 100 m).</summary>
    public static float ToGameUnitsPerSec(Velocity3 vel)
        => (float)(vel.Magnitude().MetresPerSecond.ToDouble() * 0.01);

    /// <summary>Duration (SI s) → seconds.</summary>
    public static double ToSeconds(Duration d) => d.Seconds.ToDouble();

    /// <summary>Seconds → Duration (SI s).</summary>
    public static Duration FromSeconds(double seconds) => Duration.FromSi(UnityNumerics.ToFixed(seconds));

    /// <summary>Fixed64 → float.</summary>
    public static float ToFloat(Fixed64 v) => (float)v.ToDouble();

    /// <summary>Fixed64 → double.</summary>
    public static double ToDouble(Fixed64 v) => v.ToDouble();

    /// <summary>float → Fixed64.</summary>
    public static Fixed64 ToFixed(float v) => UnityNumerics.ToFixed(v);

    /// <summary>double → Fixed64.</summary>
    public static Fixed64 ToFixed(double v) => UnityNumerics.ToFixed(v);
}
