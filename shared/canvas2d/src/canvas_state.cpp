#include "canvas_state.h"

CanvasStateManager::CanvasStateManager() {
    stack_.emplace_back(); /* default state */
}

void CanvasStateManager::save() {
    stack_.push_back(stack_.back());
}

void CanvasStateManager::restore() {
    if (stack_.size() > 1) {
        stack_.pop_back();
    }
}

CanvasDrawState &CanvasStateManager::current() {
    return stack_.back();
}

const CanvasDrawState &CanvasStateManager::current() const {
    return stack_.back();
}

void CanvasStateManager::reset() {
    stack_.clear();
    stack_.emplace_back();
}
