#pragma once
#include <cmath>
#include <string>
#include <utility>

// CEF accepts integer CSS pixels. Round cumulative movement, not each event,
// so a run of precise trackpad deltas retains its displacement. At a gesture
// boundary at most half a CSS pixel remains unrepresented on either axis.
class WheelInput {
  std::string token;
  double x = 0, y = 0, remainderX = 0, remainderY = 0, lastTime = 0;
  int modifiers = 0, directionX = 0, directionY = 0;
  bool active = false;
public:
  void reset() { active = false; remainderX = remainderY = 0; }
  std::pair<int, int> take(double dx, double dy, double px, double py,
                           int flags, const std::string &focus, double now) {
    int sx = (dx > 0) - (dx < 0), sy = (dy > 0) - (dy < 0);
    if (!active || token != focus || x != px || y != py || modifiers != flags ||
        now - lastTime > 250 || (sx && directionX && sx != directionX) ||
        (sy && directionY && sy != directionY)) reset();
    if (!active) { directionX = directionY = 0; }
    active = true; token = focus; x = px; y = py; modifiers = flags; lastTime = now;
    if (sx) directionX = sx;
    if (sy) directionY = sy;
    double totalX = remainderX + dx, totalY = remainderY + dy;
    int wholeX = (int)std::round(totalX), wholeY = (int)std::round(totalY);
    remainderX = totalX - wholeX; remainderY = totalY - wholeY;
    return {wholeX, wholeY};
  }
};
