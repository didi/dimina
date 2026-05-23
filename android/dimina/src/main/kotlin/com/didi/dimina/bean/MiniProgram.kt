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
) : Parcelable {

    constructor(parcel: Parcel) : this(
        appId = parcel.readString() ?: "",
        name = parcel.readString() ?: "",
        root = parcel.readInt() == 1,
        path = parcel.readString(),
        versionCode = parcel.readInt(),
        versionName = parcel.readString() ?: "",
        updateManifestUrl = parcel.readString() ?: "",
    )

    override fun writeToParcel(parcel: Parcel, flags: Int) {
        parcel.writeString(appId)
        parcel.writeString(name)
        parcel.writeInt(if (root) 1 else 0)
        parcel.writeString(path)
        parcel.writeInt(versionCode)
        parcel.writeString(versionName)
        parcel.writeString(updateManifestUrl)
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
