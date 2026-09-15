/** Keep transport helpers private while retaining the originating notebook namespace. */
export function buildNotebookExecutionCode(source: string): string {
  // Resolve get_ipython only when called, in the original scope, including its
  // builtin fallback. Request and discovery execution need not provide it.
  return `(lambda __ow_builtin_module, __ow_user_namespace, __ow_get_ipython:
    (lambda __ow_scope:
        __ow_builtin_module.exec(
            __ow_builtin_module.compile(${JSON.stringify(source)}, "<open-wrangler-notebook>", "exec"),
            __ow_scope,
            __ow_scope
        )
    )({
        "__builtins__": __ow_builtin_module,
        "__ow_builtins": __ow_builtin_module,
        "__ow_user_ns": __ow_user_namespace,
        "get_ipython": __ow_get_ipython
    })
)(
    (__builtins__["__import__"] if __builtins__.__class__.__name__ == "dict" else __builtins__.__import__)("builtins"),
    (__builtins__["globals"] if __builtins__.__class__.__name__ == "dict" else __builtins__.globals)(),
    lambda: get_ipython()
)\n`;
}
