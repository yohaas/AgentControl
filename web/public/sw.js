self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) {
          client.postMessage({ type: "agent-hero:notification-click", agentId: data.agentId, projectId: data.projectId });
          return client.focus();
        }
      }
    })
  );
});
