import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.LinkedHashSet
import java.util.zip.ZipFile

plugins {
    kotlin("jvm") version "2.2.0"
    id("com.gradleup.shadow") version "9.2.2"
    application
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("dev.mobile:maestro-client:2.5.1")
    implementation("dev.mobile:maestro-orchestra:2.5.1")
}

application {
    mainClass.set("limrun.maestro.LimrunBridgeRunnerKt")
}

val mergedServicesDir = layout.buildDirectory.dir("merged-services")
val mergeRuntimeServiceFiles by tasks.registering {
    inputs.files(project.configurations.runtimeClasspath)
    outputs.dir(mergedServicesDir)

    doLast {
        val outputRoot = mergedServicesDir.get().asFile
        outputRoot.deleteRecursively()
        val services = linkedMapOf<String, LinkedHashSet<String>>()
        project.configurations.runtimeClasspath.get()
            .filter { dependency -> dependency.isFile && (dependency.extension == "jar" || dependency.extension == "zip") }
            .forEach { dependency ->
                ZipFile(dependency).use { zip ->
                    zip.entries().asSequence()
                        .filter { entry -> !entry.isDirectory && entry.name.startsWith("META-INF/services/") }
                        .forEach { entry ->
                            val lines = services.getOrPut(entry.name) { linkedSetOf() }
                            zip.getInputStream(entry).bufferedReader().useLines { serviceLines ->
                                serviceLines
                                    .map { it.trim() }
                                    .filter { it.isNotEmpty() }
                                    .forEach { lines.add(it) }
                            }
                        }
                }
            }
        services.forEach { (name, lines) ->
            val output = outputRoot.resolve(name)
            output.parentFile.mkdirs()
            output.writeText(lines.joinToString(separator = "\n", postfix = "\n"))
        }
    }
}

tasks.shadowJar {
    archiveBaseName.set("limrun-maestro-ios-runner")
    archiveClassifier.set("")
    archiveVersion.set("")
    // Shadow's default classpath includes a few non-archive artifacts from Maestro's graph.
    configurations = emptyList()
    dependsOn(mergeRuntimeServiceFiles)
    exclude("META-INF/*.DSA", "META-INF/*.RSA", "META-INF/*.SF")
    manifest {
        attributes["Main-Class"] = "limrun.maestro.LimrunBridgeRunnerKt"
    }
    from(sourceSets.main.get().output)
    // Keep Shadow's service-file merging, but only expand artifacts that are real archives.
    from({
        project.configurations.runtimeClasspath.get()
            .filter { dependency -> dependency.isDirectory || dependency.extension == "jar" || dependency.extension == "zip" }
            .map { dependency ->
                if (dependency.isDirectory) {
                    dependency
                } else {
                    zipTree(dependency).matching {
                        exclude("META-INF/services/**", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/*.SF")
                    }
                }
            }
    })
    from(mergedServicesDir)
}

tasks.build {
    dependsOn(tasks.shadowJar)
}
