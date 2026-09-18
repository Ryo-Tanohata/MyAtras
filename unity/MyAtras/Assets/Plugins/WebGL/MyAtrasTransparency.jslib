// Lets the page show through around the globe, as it does around the JavaScript one.
//
// Unity creates its context with the same attributes the JavaScript globe asks for -
// alpha on, premultipliedAlpha off - but at the end of every frame it clears the alpha
// channel alone back to 1, which makes the canvas opaque whatever the shader wrote.
// This skips exactly that clear: a clear of the colour buffer while only the alpha
// channel is writable. Every other clear goes through unchanged.
var MyAtrasTransparency = {
  glClear: function (mask) {
    if (mask === 0x00004000) {  // GL_COLOR_BUFFER_BIT on its own
      var writable = GLctx.getParameter(GLctx.COLOR_WRITEMASK);
      if (!writable[0] && !writable[1] && !writable[2] && writable[3]) return;
    }
    GLctx.clear(mask);
  }
};
mergeInto(LibraryManager.library, MyAtrasTransparency);
