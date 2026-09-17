using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace MyAtras
{
    /// <summary>
    /// Builds the Web (WebGL) player into dist/unity/ with the settings the published
    /// site needs, and generates the scene it builds so that no hand-written scene or
    /// project-settings asset has to be kept in step with the editor version.
    ///
    /// From the editor:   MyAtras > Build Web (WebGL) to dist/unity
    /// From a terminal:   Unity -quit -batchmode -projectPath unity/MyAtras \
    ///                          -executeMethod MyAtras.WebGlBuild.Build
    /// </summary>
    public static class WebGlBuild
    {
        const string ScenePath = "Assets/Scenes/Main.unity";

        [MenuItem("MyAtras/Build Web (WebGL) to dist-unity")]
        public static void Build()
        {
            string output = OutputDirectory();
            Directory.CreateDirectory(output);

            ApplyPlayerSettings();
            CreateScene();

            BuildPlayerOptions options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = output,
                target = BuildTarget.WebGL,
                targetGroup = BuildTargetGroup.WebGL,
                options = BuildOptions.None,
            };

            BuildReport report = BuildPipeline.BuildPlayer(options);
            bool ok = report.summary.result == BuildResult.Succeeded;
            Debug.Log($"MyAtras: build {report.summary.result} -> {output} " +
                      $"({report.summary.totalSize / (1024 * 1024)} MB)");
            if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
        }

        /// <summary>dist/unity/ in the working tree, next to the JavaScript globe it is published with.</summary>
        static string OutputDirectory()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, "../../../dist/unity"));
        }

        static void ApplyPlayerSettings()
        {
            PlayerSettings.companyName = "MyAtras";
            PlayerSettings.productName = "MyAtras";
            PlayerSettings.runInBackground = true;

            // Gamma, because the shader is a line-for-line port of the WebGL one: in
            // linear space Unity would convert every texel on sampling and the cloud
            // threshold would no longer sit where the JavaScript version puts it.
            PlayerSettings.colorSpace = ColorSpace.Gamma;
            PlayerSettings.SetGraphicsAPIs(BuildTarget.WebGL,
                new[] { GraphicsDeviceType.OpenGLES3 });

            // GitHub Pages serves static files and sends no Content-Encoding, so the
            // loader has to be able to inflate the build itself.
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true;
            PlayerSettings.WebGL.nameFilesAsHashes = true;
            PlayerSettings.WebGL.dataCaching = true;
            PlayerSettings.SetManagedStrippingLevel(
                NamedBuildTarget.WebGL, ManagedStrippingLevel.High);
        }

        /// <summary>
        /// Writes the one scene the build needs: a camera carrying <see cref="GlobeView"/>.
        /// Generating it keeps a binary-ish YAML asset out of the repository.
        /// </summary>
        static void CreateScene()
        {
            Directory.CreateDirectory(Path.Combine(Application.dataPath, "Scenes"));

            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject cameraObject = new GameObject("Globe Camera", typeof(Camera), typeof(GlobeView));
            cameraObject.tag = "MainCamera";

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }
    }
}
