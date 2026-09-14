#pragma once
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

// Explicit local benchmark output; bounded to five minutes, no page contents.
class BrowserDiagnostics {
  using Clock = std::chrono::steady_clock;
  FILE *file = nullptr;
  Clock::time_point last = Clock::now();
  std::vector<double> pumps;
  unsigned paints = 0, reports = 0;
  double dirtyPixels = 0;
public:
  BrowserDiagnostics() {
    const char *path = std::getenv("WEAVE_BROWSER_CEF_DIAGNOSTICS_PATH");
    if (path) file = fopen(path, "a");
  }
  ~BrowserDiagnostics() { if (file) fclose(file); }
  bool enabled() const { return file != nullptr && reports < 300; }
  static double now() { return std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count(); }
  void paint(double area) { if (enabled()) { paints++; dirtyPixels += area; } }
  void pump(double start) {
    if (!enabled()) return;
    if (pumps.size() < 10000) pumps.push_back(now() - start);
    auto end = Clock::now();
    double seconds = std::chrono::duration<double>(end - last).count();
    if (seconds < 1) return;
    std::sort(pumps.begin(), pumps.end());
    double sum = 0; for (double value : pumps) sum += value;
    double epoch = std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
    fprintf(file, "{\"epochMs\":%.3f,\"seconds\":%.6f,\"paints\":%u,\"dirtyPixels\":%.0f,\"pumpCount\":%zu,\"pumpTotalMs\":%.3f,\"pumpP95Ms\":%.3f,\"pumpMaxMs\":%.3f}\n", epoch, seconds, paints, dirtyPixels, pumps.size(), sum, pumps[pumps.size()*95/100], pumps.back());
    fflush(file); reports++; last = end; paints = 0; dirtyPixels = 0; pumps.clear();
  }
};
