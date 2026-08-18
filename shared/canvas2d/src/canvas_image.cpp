#include "canvas_image.h"
#include "stb_image.h"

int ImageManager::createImageFromRGBA(NVGcontext *vg, const std::string &imageId,
                                       int w, int h, const unsigned char *data) {
    /* Delete existing image with same ID */
    auto it = images_.find(imageId);
    if (it != images_.end()) {
        nvgDeleteImage(vg, it->second);
    }

    int handle = nvgCreateImageRGBA(vg, w, h, 0, data);
    if (handle > 0) {
        images_[imageId] = handle;
    }
    return handle;
}

int ImageManager::createImageFromData(NVGcontext *vg, const std::string &imageId,
                                       const unsigned char *fileData, int dataLen) {
    int w = 0, h = 0, channels = 0;
    unsigned char *pixels = stbi_load_from_memory(fileData, dataLen, &w, &h, &channels, 4);
    if (!pixels) return -1;

    int handle = createImageFromRGBA(vg, imageId, w, h, pixels);
    stbi_image_free(pixels);
    return handle;
}

int ImageManager::getImage(const std::string &imageId) const {
    auto it = images_.find(imageId);
    return (it != images_.end()) ? it->second : -1;
}

bool ImageManager::getImageSize(NVGcontext *vg, const std::string &imageId,
                                 int *w, int *h) const {
    int handle = getImage(imageId);
    if (handle < 0) return false;
    nvgImageSize(vg, handle, w, h);
    return true;
}

void ImageManager::deleteImage(NVGcontext *vg, const std::string &imageId) {
    auto it = images_.find(imageId);
    if (it != images_.end()) {
        nvgDeleteImage(vg, it->second);
        images_.erase(it);
    }
}

void ImageManager::clear(NVGcontext *vg) {
    for (auto &p : images_) {
        nvgDeleteImage(vg, p.second);
    }
    images_.clear();
}
