#include "../native/browser/wheel-input.h"
#include <cassert>
#include <iostream>
int main() {
  WheelInput wheel;
  int totalX = 0, totalY = 0;
  for (int i = 0; i < 1000; i++) {
    auto [x, y] = wheel.take(.25, -.125, 10, 20, 0, "view:1", i);
    totalX += x; totalY += y;
  }
  assert(totalX == 250 && totalY == -125);
  wheel.reset();
  assert(wheel.take(0, .25, 10, 20, 0, "view:1", 1001).second == 0);
  assert(wheel.take(0, .25, 10, 20, 0, "view:1", 1002).second == 1);
  // Remainders cannot leak into a new owner, target, modifier or idle gesture.
  assert(wheel.take(0, .25, 10, 20, 0, "view:2", 1003).second == 0);
  assert(wheel.take(0, .25, 11, 20, 0, "view:2", 1004).second == 0);
  assert(wheel.take(0, .25, 11, 20, 8, "view:2", 1005).second == 0);
  assert(wheel.take(0, .25, 11, 20, 8, "view:2", 2000).second == 0);
  assert(wheel.take(0, -.25, 11, 20, 8, "view:2", 2001).second == 0);
  std::cout << "Fractional displacement, focus, target, modifier, idle and reversal boundaries passed\n";
}
