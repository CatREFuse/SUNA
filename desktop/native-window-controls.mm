#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <cmath>
#include <cstring>

// Stable Node-API only: no V8, Electron internals, private AppKit selectors,
// global method replacement, or replacement window buttons.
@interface SunaWindowControlState : NSObject
@property(nonatomic, strong) NSArray<NSButton *> *buttons;
@property(nonatomic, strong) NSArray<NSValue *> *frames;
@property(nonatomic, strong) NSArray<NSValue *> *bounds;
@end
@implementation SunaWindowControlState
@end
static NSMapTable<NSWindow *, SunaWindowControlState *> *states;

static napi_value Error(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message); return nullptr;
}
static napi_value Number(napi_env env, double value) { napi_value out; napi_create_double(env, value, &out); return out; }
static napi_value Bool(napi_env env, bool value) { napi_value out; napi_get_boolean(env, value, &out); return out; }
static napi_value String(napi_env env, NSString *value) { napi_value out; napi_create_string_utf8(env, value.UTF8String ?: "", NAPI_AUTO_LENGTH, &out); return out; }
static void Set(napi_env env, napi_value object, const char *key, napi_value value) { napi_set_named_property(env, object, key, value); }
static napi_value NapiRect(napi_env env, NSRect rect) {
  napi_value out; napi_create_object(env, &out);
  Set(env, out, "x", Number(env, rect.origin.x)); Set(env, out, "y", Number(env, rect.origin.y));
  Set(env, out, "width", Number(env, rect.size.width)); Set(env, out, "height", Number(env, rect.size.height)); return out;
}
static NSView *RootView(NSWindow *window) { NSView *view = window.contentView; while (view.superview) view = view.superview; return view; }
static NSView *FindView(NSView *view, uintptr_t address, NSUInteger depth, NSUInteger *budget) {
  if (!view || depth > 64 || *budget == 0) return nil;
  --*budget; if ((uintptr_t)(__bridge void *)view == address) return view;
  for (NSView *child in view.subviews) { NSView *found = FindView(child, address, depth + 1, budget); if (found) return found; }
  return nil;
}
static NSWindow *Window(napi_env env, napi_value value) {
  if (![NSThread isMainThread]) { Error(env, "NATIVE_CONTROLS_THREAD", "Native controls require the main AppKit thread"); return nil; }
  bool isBuffer = false; napi_is_buffer(env, value, &isBuffer); void *data = nullptr; size_t size = 0;
  if (!isBuffer || napi_get_buffer_info(env, value, &data, &size) != napi_ok || size != sizeof(uintptr_t)) { Error(env, "NATIVE_CONTROLS_HANDLE", "Expected an Electron native view handle"); return nil; }
  uintptr_t address = 0; std::memcpy(&address, data, sizeof(address));
  // Never dereference an arbitrary address. Match only real NSViews belonging
  // to this process's live NSWindows, then use the public view.window API.
  for (NSWindow *window in NSApp.windows) {
    NSUInteger budget = 10000; NSView *found = FindView(RootView(window), address, 0, &budget);
    if (found && found.window == window) return window;
  }
  Error(env, "NATIVE_CONTROLS_HANDLE", "The native view is no longer attached to a live window"); return nil;
}
static SunaWindowControlState *State(NSWindow *window) {
  if (!states) states = [NSMapTable weakToStrongObjectsMapTable];
  NSButton *close = [window standardWindowButton:NSWindowCloseButton], *mini = [window standardWindowButton:NSWindowMiniaturizeButton], *zoom = [window standardWindowButton:NSWindowZoomButton];
  if (!close || !mini || !zoom) return nil;
  SunaWindowControlState *state = [states objectForKey:window];
  if (state && state.buttons[0] == close && state.buttons[1] == mini && state.buttons[2] == zoom) return state;
  // AppKit may replace titlebar views during a mode transition. Never keep
  // applying geometry to old button objects detached from the current window.
  if (state) [states removeObjectForKey:window];
  state = [SunaWindowControlState new]; state.buttons = @[close, mini, zoom];
  state.frames = @[[NSValue valueWithRect:close.frame], [NSValue valueWithRect:mini.frame], [NSValue valueWithRect:zoom.frame]];
  state.bounds = @[[NSValue valueWithRect:close.bounds], [NSValue valueWithRect:mini.bounds], [NSValue valueWithRect:zoom.bounds]];
  [states setObject:state forKey:window]; return state;
}
static NSRect TopRect(NSView *root, NSRect rect) {
  if (!root.isFlipped) rect.origin.y = NSMaxY(root.bounds) - NSMaxY(rect);
  else rect.origin.y -= root.bounds.origin.y;
  rect.origin.x -= root.bounds.origin.x; return rect;
}
static napi_value Snapshot(napi_env env, NSWindow *window) {
  NSView *root = RootView(window); napi_value out, list; napi_create_object(env, &out); napi_create_array_with_length(env, 3, &list);
  NSButton *close = [window standardWindowButton:NSWindowCloseButton], *mini = [window standardWindowButton:NSWindowMiniaturizeButton], *zoom = [window standardWindowButton:NSWindowZoomButton];
  if (!root || !close || !mini || !zoom) return Error(env, "NATIVE_CONTROLS_UNAVAILABLE", "Standard controls unavailable during window transition");
  NSArray<NSButton *> *buttons = @[close, mini, zoom];
  NSArray<NSString *> *names = @[@"close", @"minimize", @"zoom"]; NSRect group = NSZeroRect;
  for (NSUInteger i = 0; i < buttons.count; i++) {
    NSButton *button = buttons[i]; NSRect rect = TopRect(root, [button convertRect:button.bounds toView:root]); group = i ? NSUnionRect(group, rect) : rect;
    napi_value item; napi_create_object(env, &item); Set(env, item, "name", String(env, names[i]));
    Set(env, item, "frame", NapiRect(env, button.frame)); Set(env, item, "bounds", NapiRect(env, button.bounds)); Set(env, item, "windowRect", NapiRect(env, rect));
    Set(env, item, "controlSize", Number(env, button.controlSize)); Set(env, item, "enabled", Bool(env, button.enabled)); Set(env, item, "hidden", Bool(env, button.hidden));
    Set(env, item, "action", String(env, button.action ? NSStringFromSelector(button.action) : @""));
    Set(env, item, "targetClass", String(env, button.target ? NSStringFromClass([button.target class]) : @""));
    Set(env, item, "nativeButton", Bool(env, [button isKindOfClass:NSButton.class]));
    NSPoint midpoint = NSMakePoint(NSMidX(button.bounds), NSMidY(button.bounds));
    NSPoint parentPoint = [button convertPoint:midpoint toView:button.superview];
    Set(env, item, "centerHit", Bool(env, [button hitTest:parentPoint] == button)); napi_set_element(env, list, (uint32_t)i, item);
  }
  Set(env, out, "buttons", list); Set(env, out, "group", NapiRect(env, group)); Set(env, out, "centerX", Number(env, NSMidX(group)));
  Set(env, out, "windowHeight", Number(env, root.bounds.size.height)); Set(env, out, "backingScaleFactor", Number(env, window.backingScaleFactor));
  Set(env, out, "miniaturized", Bool(env, window.miniaturized)); Set(env, out, "zoomed", Bool(env, window.zoomed)); return out;
}
static bool Option(napi_env env, napi_value options, const char *key, double *out, double minimum, double maximum) {
  napi_value value; napi_valuetype type;
  if (napi_get_named_property(env, options, key, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok || type != napi_number || napi_get_value_double(env, value, out) != napi_ok || !std::isfinite(*out) || *out < minimum || *out > maximum) {
    Error(env, "NATIVE_CONTROLS_OPTIONS", "Invalid native control geometry"); return false;
  }
  return true;
}
static napi_value Apply(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) return Error(env, "NATIVE_CONTROLS_OPTIONS", "Expected handle and geometry");
    double rail, scale, gap, centerY;
    if (!Option(env, args[1], "railWidth", &rail, 44, 128) || !Option(env, args[1], "scale", &scale, .5, 1) || !Option(env, args[1], "gap", &gap, 0, 12) || !Option(env, args[1], "centerY", &centerY, 8, 44)) return nullptr;
    NSWindow *window = Window(env, args[0]); if (!window) return nullptr;
    SunaWindowControlState *state = State(window); if (!state) return Error(env, "NATIVE_CONTROLS_UNAVAILABLE", "This window has no standard controls");
    CGFloat total = gap * 2; for (NSValue *value in state.bounds) total += value.rectValue.size.width * scale;
    if (total >= rail) return Error(env, "NATIVE_CONTROLS_OPTIONS", "Native controls do not fit the sidebar");
    NSView *root = RootView(window); CGFloat x = (rail - total) / 2;
    for (NSUInteger i = 0; i < state.buttons.count; i++) {
      NSButton *button = state.buttons[i]; NSRect original = state.bounds[i].rectValue;
      NSSize size = NSMakeSize(original.size.width * scale, original.size.height * scale);
      CGFloat y = root.isFlipped ? NSMinY(root.bounds) + centerY - size.height / 2 : NSMaxY(root.bounds) - centerY - size.height / 2;
      NSRect desired = NSMakeRect(NSMinX(root.bounds) + x, y, size.width, size.height);
      button.frame = [root convertRect:desired toView:button.superview];
      // Keep the original AppKit drawing coordinates. Only the actual NSView
      // frame shrinks, so system glyphs scale rather than being cropped.
      button.bounds = original; x += size.width + gap;
    }
    return Snapshot(env, window);
  }
}
static napi_value Inspect(napi_env env, napi_callback_info info) {
  @autoreleasepool { size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr); if (argc != 1) return Error(env, "NATIVE_CONTROLS_HANDLE", "Expected native handle"); NSWindow *window = Window(env, arg); if (!window || !State(window)) return window ? Error(env, "NATIVE_CONTROLS_UNAVAILABLE", "Standard controls unavailable") : nullptr; return Snapshot(env, window); }
}
static napi_value Restore(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr); if (argc != 1) return Error(env, "NATIVE_CONTROLS_HANDLE", "Expected native handle");
    NSWindow *window = Window(env, arg); if (!window) return nullptr; SunaWindowControlState *state = [states objectForKey:window];
    if (state) { for (NSUInteger i = 0; i < state.buttons.count; i++) { state.buttons[i].frame = state.frames[i].rectValue; state.buttons[i].bounds = state.bounds[i].rectValue; } [states removeObjectForKey:window]; }
    napi_value out; napi_get_undefined(env, &out); return out;
  }
}
// These two APIs are intentionally not exposed by the production JS controller.
// They let an isolated native harness verify AppKit drawing and original actions.
static napi_value Perform(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 2; napi_value args[2]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr); char name[16]; size_t length = 0;
    if (argc != 2 || napi_get_value_string_utf8(env, args[1], name, sizeof(name), &length) != napi_ok || length >= sizeof(name)) return Error(env, "NATIVE_CONTROLS_OPTIONS", "Unknown button");
    NSWindow *window = Window(env, args[0]); if (!window) return nullptr;
    NSWindowButton kind; if (!std::strcmp(name, "close")) kind = NSWindowCloseButton; else if (!std::strcmp(name, "minimize")) kind = NSWindowMiniaturizeButton; else if (!std::strcmp(name, "zoom")) kind = NSWindowZoomButton; else return Error(env, "NATIVE_CONTROLS_OPTIONS", "Unknown button");
    [[window standardWindowButton:kind] performClick:nil]; napi_value out; napi_get_undefined(env, &out); return out;
  }
}
static napi_value Capture(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1; napi_value arg; napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr); if (argc != 1) return Error(env, "NATIVE_CONTROLS_HANDLE", "Expected native handle");
    NSWindow *window = Window(env, arg); if (!window) return nullptr; NSView *root = RootView(window);
    NSRect rect = NSMakeRect(NSMinX(root.bounds), root.isFlipped ? NSMinY(root.bounds) : NSMaxY(root.bounds) - 44, 64, 44);
    NSBitmapImageRep *rep = [root bitmapImageRepForCachingDisplayInRect:rect]; if (!rep) return Error(env, "NATIVE_CONTROLS_UNAVAILABLE", "Native view cannot be rendered");
    [root cacheDisplayInRect:rect toBitmapImageRep:rep]; NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png || png.length > 1024 * 1024) return Error(env, "NATIVE_CONTROLS_UNAVAILABLE", "Native view rendering failed");
    napi_value out, data; napi_create_object(env, &out); napi_create_buffer_copy(env, png.length, png.bytes, nullptr, &data);
    Set(env, out, "data", data); Set(env, out, "width", Number(env, rep.pixelsWide)); Set(env, out, "height", Number(env, rep.pixelsHigh)); return out;
  }
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr}, {"inspect", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"restore", nullptr, Restore, nullptr, nullptr, nullptr, napi_default, nullptr}, {"perform", nullptr, Perform, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"capture", nullptr, Capture, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors); return exports;
}
NAPI_MODULE(native_window_controls, Init)
