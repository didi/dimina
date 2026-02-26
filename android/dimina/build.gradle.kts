plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
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
    }
    
    // Add configuration to not compress jsapp files
    androidResources {
        noCompress += listOf("json", "zip") // Don't compress these files
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
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.mmkv)
    implementation (libs.okhttp)
    implementation(libs.landscapist.coil)
    implementation (libs.ui.tooling)
    implementation(libs.androidx.bluetooth)
    testImplementation(libs.junit)
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