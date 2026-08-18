#ifndef DIMINA_CANVAS_IMAGE_H
#define DIMINA_CANVAS_IMAGE_H

#include "nanovg.h"
#include <string>
#include <map>

/**
 * Manages image textures for drawImage.
 * Images are uploaded to NanoVG (GPU texture) and referenced by a string ID.
 */
class ImageManager {
public:
    /**
     * Create an image from raw RGBA pixel data.
     * Returns the NanoVG image handle, or -1 on failure.
     */
    int createImageFromRGBA(NVGcontext *vg, const std::string &imageId,
                            int w, int h, const unsigned char *data);

    /**
     * Create an image by decoding file data (PNG, JPEG, etc. via stb_image).
     * Returns the NanoVG image handle, or -1 on failure.
     */
    int createImageFromData(NVGcontext *vg, const std::string &imageId,
                            const unsigned char *fileData, int dataLen);

    /** Get NanoVG image handle by imageId. Returns -1 if not found. */
    int getImage(const std::string &imageId) const;

    /** Get image dimensions. Returns false if not found. */
    bool getImageSize(NVGcontext *vg, const std::string &imageId,
                      int *w, int *h) const;

    /** Delete a single image. */
    void deleteImage(NVGcontext *vg, const std::string &imageId);

    /** Delete all images. */
    void clear(NVGcontext *vg);

private:
    std::map<std::string, int> images_; /* imageId → NanoVG handle */
};

#endif /* DIMINA_CANVAS_IMAGE_H */
