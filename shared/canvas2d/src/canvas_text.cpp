#include "canvas_text.h"
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <sstream>
#include <cctype>

static std::string toLower(const std::string &s) {
    std::string r = s;
    for (auto &c : r) c = (char)std::tolower((unsigned char)c);
    return r;
}

static std::string stripQuotes(const std::string &s) {
    if (s.size() >= 2) {
        char f = s.front(), b = s.back();
        if ((f == '"' && b == '"') || (f == '\'' && b == '\''))
            return s.substr(1, s.size() - 2);
    }
    return s;
}

ParsedFont parseCSSFont(const std::string &fontStr) {
    ParsedFont result;
    if (fontStr.empty()) return result;

    /* Tokenize by whitespace, respecting quoted strings */
    std::vector<std::string> tokens;
    {
        std::string current;
        bool inQuote = false;
        char quoteChar = 0;
        for (size_t i = 0; i < fontStr.size(); i++) {
            char c = fontStr[i];
            if (inQuote) {
                if (c == quoteChar) {
                    inQuote = false;
                    current += c;
                } else {
                    current += c;
                }
            } else if (c == '"' || c == '\'') {
                inQuote = true;
                quoteChar = c;
                current += c;
            } else if (c == ' ' || c == '\t') {
                if (!current.empty()) {
                    tokens.push_back(current);
                    current.clear();
                }
            } else {
                current += c;
            }
        }
        if (!current.empty()) tokens.push_back(current);
    }

    size_t idx = 0;

    /* Parse optional font-style and font-weight tokens */
    while (idx < tokens.size()) {
        std::string low = toLower(tokens[idx]);
        if (low == "italic" || low == "oblique") {
            result.italic = true;
            idx++;
        } else if (low == "bold") {
            result.weight = 700;
            idx++;
        } else if (low == "normal") {
            idx++;
        } else if (low == "lighter") {
            result.weight = 300;
            idx++;
        } else if (low == "bolder") {
            result.weight = 800;
            idx++;
        } else {
            /* Check numeric weight */
            char *end = nullptr;
            long w = strtol(low.c_str(), &end, 10);
            if (end != low.c_str() && *end == '\0' && w >= 100 && w <= 900) {
                result.weight = (int)w;
                idx++;
            } else {
                break;
            }
        }
    }

    /* Parse font-size (e.g. "14px", "1.5em", "12pt") */
    if (idx < tokens.size()) {
        std::string sizeToken = tokens[idx];
        /* Handle "14px/1.2" line-height syntax */
        auto slash = sizeToken.find('/');
        if (slash != std::string::npos) {
            sizeToken = sizeToken.substr(0, slash);
        }
        char *end = nullptr;
        float sz = strtof(sizeToken.c_str(), &end);
        if (end != sizeToken.c_str()) {
            /* Convert pt → px roughly */
            if (end && strcmp(end, "pt") == 0) {
                sz *= 1.333f;
            }
            result.size = sz;
        }
        idx++;
    }

    /* Remaining tokens are font-family (may be comma-separated) */
    if (idx < tokens.size()) {
        std::string family;
        for (size_t i = idx; i < tokens.size(); i++) {
            if (!family.empty()) family += " ";
            family += tokens[i];
        }
        /* Take first family in comma-separated list */
        auto comma = family.find(',');
        if (comma != std::string::npos) {
            family = family.substr(0, comma);
        }
        /* Strip quotes and trailing whitespace */
        family = stripQuotes(family);
        while (!family.empty() && (family.back() == ' ' || family.back() == ','))
            family.pop_back();
        if (!family.empty()) {
            result.family = family;
        }
    }

    return result;
}

int parseTextAlign(const std::string &align) {
    if (align == "right" || align == "end") return NVG_ALIGN_RIGHT;
    if (align == "center")                  return NVG_ALIGN_CENTER;
    return NVG_ALIGN_LEFT; /* "left", "start", default */
}

int parseTextBaseline(const std::string &baseline) {
    if (baseline == "top" || baseline == "hanging")    return NVG_ALIGN_TOP;
    if (baseline == "middle")                          return NVG_ALIGN_MIDDLE;
    if (baseline == "bottom" || baseline == "ideographic") return NVG_ALIGN_BOTTOM;
    return NVG_ALIGN_BASELINE; /* "alphabetic", default */
}

void applyFontToNVG(NVGcontext *vg, const ParsedFont &font) {
    nvgFontSize(vg, font.size);

    /* Try to find the font face; fall back to "sans" */
    int faceId = nvgFindFont(vg, font.family.c_str());
    if (faceId < 0) {
        /* Try common fallback names */
        faceId = nvgFindFont(vg, "sans");
    }
    if (faceId >= 0) {
        nvgFontFaceId(vg, faceId);
    }
}
