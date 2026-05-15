package limrun.maestro

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.runBlocking
import maestro.Capability
import maestro.DeviceInfo
import maestro.Driver
import maestro.KeyCode
import maestro.Maestro
import maestro.OnDeviceElementQuery
import maestro.Point
import maestro.ScreenRecording
import maestro.SwipeDirection
import maestro.TreeNode
import maestro.ViewHierarchy
import maestro.device.DeviceOrientation
import maestro.device.Platform
import maestro.orchestra.Orchestra
import maestro.orchestra.util.Env.withDefaultEnvVars
import maestro.orchestra.util.Env.withEnv
import maestro.orchestra.util.Env.withInjectedShellEnvVars
import maestro.orchestra.yaml.YamlCommandReader
import okio.Sink
import okio.buffer
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.Base64

private const val VERSION = "2.5.1-lim.1"
private const val MAESTRO_VERSION = "2.5.1"

fun main(args: Array<String>) {
    val config = RunnerConfig.parse(args) ?: return
    config.screenshotsDir?.let { Files.createDirectories(it) }

    val flowFile = config.flowPath.toFile()
    val env = emptyMap<String, String>()
        .withInjectedShellEnvVars()
        .withDefaultEnvVars(flowFile, config.deviceId)
    val commands = YamlCommandReader.readCommands(config.flowPath)
        .withEnv(env)
    val driver = LimrunBridgeDriver(config.bridgeUrl)
    try {
        driver.open()
        Maestro(driver).use { maestro ->
            val success = runBlocking {
                Orchestra(
                    maestro = maestro,
                    screenshotsDir = config.screenshotsDir,
                ).runFlow(commands)
            }
            check(success) { "Maestro flow returned false" }
        }
    } finally {
        driver.close()
    }
}

private data class RunnerConfig(
    val bridgeUrl: String,
    val deviceId: String?,
    val flowPath: Path,
    val screenshotsDir: Path?,
) {
    companion object {
        fun parse(args: Array<String>): RunnerConfig? {
            if (args.contains("--version")) {
                println("limrun-maestro-ios-runner $VERSION (Maestro $MAESTRO_VERSION)")
                return null
            }
            if (args.contains("--help") || args.contains("-h")) {
                println("Usage: java -jar limrun-maestro-ios-runner.jar --bridge-url <url> --flow <flow.yaml> [--device-id <udid>] [--screenshots-dir <dir>]")
                return null
            }

            val values = mutableMapOf<String, String>()
            var index = 0
            while (index < args.size) {
                val key = args[index]
                if (!key.startsWith("--")) {
                    error("Unexpected argument: $key")
                }
                val value = args.getOrNull(index + 1) ?: error("Missing value for $key")
                values[key] = value
                index += 2
            }

            val bridgeUrl = values["--bridge-url"] ?: error("--bridge-url is required")
            val flow = values["--flow"] ?: error("--flow is required")
            return RunnerConfig(
                bridgeUrl = bridgeUrl,
                deviceId = values["--device-id"]?.takeIf { it.isNotBlank() },
                flowPath = Paths.get(flow),
                screenshotsDir = values["--screenshots-dir"]?.takeIf { it.isNotBlank() }?.let { Paths.get(it) },
            )
        }
    }
}

private class LimrunBridgeDriver(
    bridgeUrl: String,
) : Driver {
    private val baseUrl = bridgeUrl.trimEnd('/')
    private val http = HttpClient.newBuilder().build()
    private val mapper = jacksonObjectMapper()
    private var open = false

    override fun name(): String = "Limrun iOS Bridge"

    override fun open() {
        post("open")
        open = true
    }

    override fun close() {
        if (open) {
            post("close")
            open = false
        }
    }

    override fun deviceInfo(): DeviceInfo {
        val payload = post("deviceInfo")
        return DeviceInfo(
            platform = Platform.IOS,
            widthPixels = payload["widthPixels"].asInt(),
            heightPixels = payload["heightPixels"].asInt(),
            widthGrid = payload["widthGrid"].asInt(),
            heightGrid = payload["heightGrid"].asInt(),
        )
    }

    override fun launchApp(appId: String, launchArguments: Map<String, Any>) {
        post("launchApp", mapOf("appId" to appId, "launchArguments" to launchArguments))
    }

    override fun stopApp(appId: String) {
        post("stopApp", mapOf("appId" to appId))
    }

    override fun killApp(appId: String) {
        stopApp(appId)
    }

    override fun clearAppState(appId: String) {
        post("clearAppState", mapOf("appId" to appId))
    }

    override fun clearKeychain() {
        post("clearKeychain")
    }

    override fun tap(point: Point) {
        post("tap", mapOf("x" to point.x, "y" to point.y))
    }

    override fun longPress(point: Point) {
        post("longPress", mapOf("x" to point.x, "y" to point.y))
    }

    override fun pressKey(code: KeyCode) {
        post("pressKey", mapOf("code" to code.name))
    }

    override fun contentDescriptor(excludeKeyboardElements: Boolean): TreeNode {
        return mapper.treeToValue(
            post("contentDescriptor", mapOf("excludeKeyboardElements" to excludeKeyboardElements)),
            TreeNode::class.java,
        )
    }

    override fun scrollVertical() {
        post("scroll", mapOf("direction" to "down", "pixels" to 400))
    }

    override fun isKeyboardVisible(): Boolean {
        return post("isKeyboardVisible")["visible"].asBoolean()
    }

    override fun swipe(start: Point, end: Point, durationMs: Long) {
        post(
            "swipe",
            mapOf(
                "start" to mapOf("x" to start.x, "y" to start.y),
                "end" to mapOf("x" to end.x, "y" to end.y),
                "durationMs" to durationMs,
            ),
        )
    }

    override fun swipe(swipeDirection: SwipeDirection, durationMs: Long) {
        post("swipeDirection", mapOf("direction" to swipeDirection.name, "durationMs" to durationMs))
    }

    override fun swipe(elementPoint: Point, direction: SwipeDirection, durationMs: Long) {
        post(
            "swipeElement",
            mapOf(
                "x" to elementPoint.x,
                "y" to elementPoint.y,
                "direction" to direction.name,
                "durationMs" to durationMs,
            ),
        )
    }

    override fun backPress() {
        post("pressKey", mapOf("code" to "BACK"))
    }

    override fun inputText(text: String) {
        post("inputText", mapOf("text" to text))
    }

    override fun openLink(link: String, appId: String?, autoVerify: Boolean, browser: Boolean) {
        post("openLink", mapOf("link" to link, "appId" to appId, "autoVerify" to autoVerify, "browser" to browser))
    }

    override fun hideKeyboard() {
        post("hideKeyboard")
    }

    override fun takeScreenshot(out: Sink, compressed: Boolean) {
        val bytes = Base64.getDecoder().decode(post("takeScreenshot", mapOf("compressed" to compressed))["base64"].asText())
        out.buffer().use { it.write(bytes) }
    }

    override fun startScreenRecording(out: Sink): ScreenRecording {
        post("startScreenRecording")
        return object : ScreenRecording {
            override fun close() {
                val bytes = Base64.getDecoder().decode(post("stopScreenRecording")["base64"].asText())
                out.buffer().use { it.write(bytes) }
            }
        }
    }

    override fun setLocation(latitude: Double, longitude: Double) {
        post("setLocation", mapOf("latitude" to latitude, "longitude" to longitude))
    }

    override fun setOrientation(orientation: DeviceOrientation) {
        post("setOrientation", mapOf("orientation" to orientation.name))
    }

    override fun eraseText(charactersToErase: Int) {
        post("eraseText", mapOf("charactersToErase" to charactersToErase))
    }

    override fun setProxy(host: String, port: Int) {
        post("setProxy", mapOf("host" to host, "port" to port))
    }

    override fun resetProxy() {
        post("resetProxy")
    }

    override fun isShutdown(): Boolean = !open

    override fun isUnicodeInputSupported(): Boolean = true

    override fun waitUntilScreenIsStatic(timeoutMs: Long): Boolean {
        return post("waitUntilScreenIsStatic", mapOf("timeoutMs" to timeoutMs))["static"].asBoolean()
    }

    override fun waitForAppToSettle(initialHierarchy: ViewHierarchy?, appId: String?, timeoutMs: Int?): ViewHierarchy? {
        post("waitForAppToSettle", mapOf("appId" to appId, "timeoutMs" to timeoutMs))
        return null
    }

    override fun capabilities(): List<Capability> = emptyList()

    override fun setPermissions(appId: String, permissions: Map<String, String>) {
        post("setPermissions", mapOf("appId" to appId, "permissions" to permissions))
    }

    override fun addMedia(mediaFiles: List<File>) {
        post("addMedia", mapOf("paths" to mediaFiles.map { it.absolutePath }))
    }

    override fun isAirplaneModeEnabled(): Boolean {
        return post("isAirplaneModeEnabled")["enabled"].asBoolean()
    }

    override fun setAirplaneMode(enabled: Boolean) {
        post("setAirplaneMode", mapOf("enabled" to enabled))
    }

    override fun queryOnDeviceElements(query: OnDeviceElementQuery): List<TreeNode> {
        // Maestro's on-device element query path is Android-specific in practice for this runner.
        throw UnsupportedOperationException("On-device element queries are not supported by Limrun iOS yet")
    }

    private fun post(path: String, body: Any? = emptyMap<String, Any?>()): JsonNode {
        val request = HttpRequest.newBuilder()
            .uri(URI.create("$baseUrl/$path"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
            .build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw IllegalStateException("Bridge request $path failed: HTTP ${response.statusCode()} ${response.body()}")
        }
        return mapper.readTree(response.body())
    }
}
