using System;
using System.IO;
using UnityEditor;
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
    /// From a terminal:   Unity -batchmode -projectPath unity/MyAtras \
    ///                          -executeMethod MyAtras.WebGlBuild.Build [-outputPath PATH]
    ///
    /// The player settings here follow the ones proven in the author's other Unity
    /// WebGL project, which ships from the same editor version: Gzip with the
    /// decompression fallback because a static host sends no Content-Encoding, and
    /// hashed file names so a cached .data can never be paired with a newer .wasm
    /// (that pairing crashes on startup with "memory access out of bounds").
    /// </summary>
    public static class WebGlBuild
    {
        const string ScenePath = "Assets/Scenes/Main.unity";
        // Every shader the build must keep. Nothing references them through a material
        // asset, so each one has to be named here or it is stripped.
        static readonly string[] ShaderNames = { "MyAtras/EarthComposite", "MyAtras/StormMarks" };
        const string OutputArgument = "-outputPath";

        [MenuItem("MyAtras/Build Web (WebGL) to dist-unity")]
        public static void Build()
        {
            string output = ReadArgument(OutputArgument);
            if (string.IsNullOrEmpty(output)) output = DefaultOutputDirectory();

            bool ok = Run(output);
            if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
        }

        static bool Run(string output)
        {
            try
            {
                Directory.CreateDirectory(output);
                ApplyPlayerSettings();
                EnsureShaderIncluded();
                CreateScene();

                BuildPlayerOptions options = new BuildPlayerOptions
                {
                    scenes = new[] { ScenePath },
                    locationPathName = output,
                    target = BuildTarget.WebGL,
                    targetGroup = BuildTargetGroup.WebGL,
                    options = BuildOptions.None,
                };

                Debug.Log($"MyAtras: building {ScenePath} -> {output}");
                BuildReport report = BuildPipeline.BuildPlayer(options);
                BuildSummary summary = report.summary;
                Debug.Log($"MyAtras: {summary.result} in {summary.totalTime}, " +
                          $"{summary.totalSize / (1024 * 1024)} MB, " +
                          $"{summary.totalErrors} error(s), {summary.totalWarnings} warning(s)");

                if (summary.result == BuildResult.Succeeded) return true;

                foreach (BuildStep step in report.steps)
                {
                    foreach (BuildStepMessage message in step.messages)
                    {
                        if (message.type == LogType.Error || message.type == LogType.Exception)
                        {
                            Debug.LogError($"MyAtras: {step.name}: {message.content}");
                        }
                    }
                }
                return false;
            }
            catch (Exception error)
            {
                Debug.LogError("MyAtras: the build threw: " + error);
                return false;
            }
        }

        /// <summary>dist/unity/ in the working tree, next to the JavaScript globe it is published with.</summary>
        static string DefaultOutputDirectory()
        {
            return Path.GetFullPath(Path.Combine(Application.dataPath, "../../../dist/unity"));
        }

        static void ApplyPlayerSettings()
        {
            PlayerSettings.companyName = "MyAtras";
            PlayerSettings.productName = "MyAtras";
            PlayerSettings.runInBackground = true;
            PlayerSettings.SplashScreen.show = false;
            PlayerSettings.stripEngineCode = true;

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

            // Assets/WebGLTemplates/MyAtras: the JavaScript site's page and stylesheet
            // around the canvas, so both versions look alike and speak Japanese without
            // the build carrying a font.
            PlayerSettings.WebGL.template = "PROJECT:MyAtras";
        }

        /// <summary>
        /// Registers the globe shader in Always Included Shaders.
        ///
        /// Nothing in the project references it through a material asset — the scene is
        /// generated and the material is created at runtime — so the build would strip
        /// it, <c>Shader.Find</c> would return null in the browser, and the page would
        /// come up empty while the editor looked fine.
        /// </summary>
        static void EnsureShaderIncluded()
        {
            foreach (string name in ShaderNames) EnsureOneShaderIncluded(name);
        }

        static void EnsureOneShaderIncluded(string shaderName)
        {
            Shader shader = Shader.Find(shaderName);
            if (shader == null)
            {
                Debug.LogError($"MyAtras: the shader \"{shaderName}\" is missing from the project.");
                return;
            }

            UnityEngine.Object[] graphics =
                AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset");
            if (graphics == null || graphics.Length == 0)
            {
                Debug.LogWarning("MyAtras: GraphicsSettings.asset could not be read; the shader may be stripped.");
                return;
            }

            SerializedObject settings = new SerializedObject(graphics[0]);
            SerializedProperty list = settings.FindProperty("m_AlwaysIncludedShaders");
            if (list == null)
            {
                Debug.LogWarning("MyAtras: m_AlwaysIncludedShaders was not found; the shader may be stripped.");
                return;
            }

            for (int i = 0; i < list.arraySize; i++)
            {
                if (list.GetArrayElementAtIndex(i).objectReferenceValue == shader) return;
            }

            list.InsertArrayElementAtIndex(list.arraySize);
            list.GetArrayElementAtIndex(list.arraySize - 1).objectReferenceValue = shader;
            settings.ApplyModifiedProperties();
            AssetDatabase.SaveAssets();
            Debug.Log($"MyAtras: added {shaderName} to the always-included shaders.");
        }

        /// <summary>
        /// Writes the one scene the build needs: a camera carrying <see cref="GlobeView"/>.
        /// Generating it keeps a hand-written YAML asset out of the repository.
        /// </summary>
        static void CreateScene()
        {
            Directory.CreateDirectory(Path.Combine(Application.dataPath, "Scenes"));

            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            // The page reaches the globe through SendMessage, which finds it by this name.
            GameObject cameraObject = new GameObject(GlobeView.ObjectName, typeof(Camera), typeof(GlobeView));
            cameraObject.tag = "MainCamera";

            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        static string ReadArgument(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], name, StringComparison.Ordinal)) return args[i + 1];
            }
            return null;
        }
    }
}
