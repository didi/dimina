plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.maven.publish)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

android {
    namespace = "com.didi.dimina"
    compileSdk = 35

    defaultConfig {
        minSdk = 26

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
        
        buildConfigField("String", "SDK_VERSION", "\"${project.property("DIMINA_VERSION")}\"")
        
        // Only include ARM architectures
        ndk {
            abiFilters.add("arm64-v8a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    
    // Add configuration to not compress jsapp files
    androidResources {
        noCompress += listOf("json", "zip") // Don't compress these files
    }
}

// Release AAR behavior (including host-controlled debugging) needs its own regression run.
androidComponents {
    beforeVariants(selector().withBuildType("release")) { variant ->
        variant.hostTests[com.android.build.api.variant.HostTestBuilder.UNIT_TEST_TYPE]?.enable = true
    }
}

dependencies {
    implementation(project(":engine_qjs"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.brotli.dec)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.mmkv)
    implementation (libs.okhttp)
    implementation(libs.landscapist.coil)
    implementation (libs.ui.tooling)
    implementation(libs.zxing.android.embedded)
    implementation(libs.androidx.media3.common)
    implementation(libs.androidx.media3.effect)
    implementation(libs.androidx.media3.transformer)
    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

android {
    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = project.property("DIMINA_GROUP_ID") as String
                artifactId = project.property("DIMINA_ARTIFACT_ID") as String
                version = project.property("DIMINA_VERSION") as String
                
                pom {
                    name.set("Dimina")
                    description.set("Dimina Android Framework")
                    url.set("https://github.com/didi/dimina")
                    licenses {
                        license {
                            name.set("The Apache License, Version 2.0")
                            url.set("http://www.apache.org/licenses/LICENSE-2.0.txt")
                        }
                    }
                }
            }
        }
    }
}

// Add task to copy shared jssdk files to Android dimina's assets folder
tasks.register<Copy>("copySharedJssdkToAssets") {
    from("${rootProject.projectDir}/../shared/jssdk")
    into("${projectDir}/src/main/assets/jssdk")
    includeEmptyDirs = true
}

// Make the preBuild task depend on the copy tasks
tasks.named("preBuild") {
    dependsOn("copySharedJssdkToAssets")
}

// Test assets come from tracked sources, independently of any mini-program ID
// or locally compiled mini-program ZIP. Sync also removes obsolete generated assets.
val copyCanvasTestFixture by tasks.registering(Sync::class) {
    val example = "${rootProject.projectDir}/../examples/miniprogram/base"
    from("$example/miniprogram_npm/libpag-miniprogram/index.js") { into("pag") }
    from("$example/pages/libpag/assets") {
        include("libpag.wasm.br", "video.pag")
        into("pag")
    }
    into("${projectDir}/src/androidTest/assets/generated")
    preserve { include(".gitignore") }
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("AndroidTestAssets") }.configureEach {
    dependsOn(copyCanvasTestFixture)
}
