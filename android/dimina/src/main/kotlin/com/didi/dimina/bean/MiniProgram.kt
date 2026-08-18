package com.didi.dimina.bean

import android.os.Parcel
import android.os.Parcelable


// Data class to represent a mini-program
data class MiniProgram(
    val appId: String,
    val name: String = "",
    val root: Boolean = true,
    val path: String?,
    val versionCode: Int = 0,
    val versionName: String = "",
    val updateManifestUrl: String = "",
    /** Scene delivered to App.onLaunch/App.onShow for this root runtime. */
    val scene: Int = 1001,
    /** The mini program that opened this one; null means the host opened it directly. */
    val openerAppId: String? = null,
    /** JSON object forwarded as referrerInfo.extraData on the initial launch. */
    val referrerExtraData: String? = null,
    /** Bundled packages currently represent the release environment only. */
    val envVersion: String = "release",
) : Parcelable {

    /** Keeps the original public seven-argument JVM constructor binary-compatible. */
    constructor(
        appId: String,
        name: String,
        root: Boolean,
        path: String?,
        versionCode: Int,
        versionName: String,
        updateManifestUrl: String,
    ) : this(
        appId = appId,
        name = name,
        root = root,
        path = path,
        versionCode = versionCode,
        versionName = versionName,
        updateManifestUrl = updateManifestUrl,
        scene = 1001,
        openerAppId = null,
        referrerExtraData = null,
        envVersion = "release",
    )

    constructor(parcel: Parcel) : this(
        appId = parcel.readString() ?: "",
        name = parcel.readString() ?: "",
        root = parcel.readInt() == 1,
        path = parcel.readString(),
        versionCode = parcel.readInt(),
        versionName = parcel.readString() ?: "",
        updateManifestUrl = parcel.readString() ?: "",
        scene = parcel.readInt(),
        openerAppId = parcel.readString(),
        referrerExtraData = parcel.readString(),
        envVersion = parcel.readString() ?: "release",
    )

    override fun writeToParcel(parcel: Parcel, flags: Int) {
        parcel.writeString(appId)
        parcel.writeString(name)
        parcel.writeInt(if (root) 1 else 0)
        parcel.writeString(path)
        parcel.writeInt(versionCode)
        parcel.writeString(versionName)
        parcel.writeString(updateManifestUrl)
        parcel.writeInt(scene)
        parcel.writeString(openerAppId)
        parcel.writeString(referrerExtraData)
        parcel.writeString(envVersion)
    }

    // 描述内容，通常返回 0
    override fun describeContents(): Int {
        return 0
    }

    // Parcelable.Creator，用于创建对象实例
    companion object CREATOR : Parcelable.Creator<MiniProgram> {
        override fun createFromParcel(parcel: Parcel): MiniProgram {
            return MiniProgram(parcel)
        }

        override fun newArray(size: Int): Array<MiniProgram?> {
            return arrayOfNulls(size)
        }
    }
}
