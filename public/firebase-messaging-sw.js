/* Service worker de push FCM — SIN claves.
 *
 * La config de Firebase llega en la query (?apiKey=…&projectId=…) que le pasa
 * `registerPushToken` (src/lib/push/fcm.ts): aquí no hay ninguna clave
 * escrita. Solo pinta la notificación cuando la app está cerrada; con la app
 * abierta los mensajes los muestra la propia UI.
 */
importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js",
);

(function () {
  var params = new URLSearchParams(self.location.search);
  var config = {
    apiKey: params.get("apiKey") || "",
    authDomain: params.get("authDomain") || "",
    projectId: params.get("projectId") || "",
    messagingSenderId: params.get("messagingSenderId") || "",
    appId: params.get("appId") || "",
  };
  if (!config.apiKey || !config.projectId || !config.appId) return;
  try {
    firebase.initializeApp(config);
    var messaging = firebase.messaging();
    messaging.onBackgroundMessage(function (payload) {
      var title =
        (payload.notification && payload.notification.title) || "Loki";
      var body =
        (payload.notification && payload.notification.body) || "";
      var data = payload.data || {};
      self.registration.showNotification(title, {
        body: body,
        data: data,
        tag: data.chat_id
          ? data.workspace_id + "/" + data.chat_id
          : undefined,
      });
    });
    // Tocar la push abre su link (p. ej. /inicio?vista=dia de "Tu día").
    self.addEventListener("notificationclick", function (event) {
      event.notification.close();
      var raw = event.notification.data || {};
      var link =
        typeof raw.link === "string" && raw.link.charAt(0) === "/"
          ? raw.link
          : "/notificaciones";
      event.waitUntil(
        self.clients
          .matchAll({ type: "window", includeUncontrolled: true })
          .then(function (clients) {
            for (var i = 0; i < clients.length; i += 1) {
              var client = clients[i];
              if ("navigate" in client) {
                client.navigate(link);
                return client.focus();
              }
            }
            return self.clients.openWindow(link);
          }),
      );
    });
  } catch {
    // Sin config válida no hay push: el worker queda inerte.
  }
})();
