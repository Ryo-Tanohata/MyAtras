// Hands the globe's state to the page around it. The page, not Unity, draws every
// word the viewer reads - buttons, times, notes, credits - so the Unity build needs no
// font of its own and shares the JavaScript site's stylesheet. See GlobeView.Report.
mergeInto(LibraryManager.library, {
  MyAtrasReport: function (json) {
    var text = UTF8ToString(json);
    if (typeof window !== 'undefined' && typeof window.myatrasReport === 'function') {
      window.myatrasReport(text);
    }
  }
});
