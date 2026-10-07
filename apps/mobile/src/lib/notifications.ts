import * as Notifications from "expo-notifications";
import * as Device from "expo-device";

export async function initializeNotifications() {
  if (!Device.isDevice) {
    console.log("[NOTIFICATIONS] Skipping notifications setup on simulator");
    return;
  }

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("[NOTIFICATIONS] Notification permissions not granted");
      return;
    }

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });

    console.log("[NOTIFICATIONS] Initialized successfully");
  } catch (error) {
    console.error("[NOTIFICATIONS] Initialization error:", error);
  }
}

export async function scheduleNotification(
  title: string,
  body: string,
  trigger: Notifications.NotificationTriggerInput
) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: "default",
        badge: 1,
      },
      trigger,
    });
    console.log(`[NOTIFICATIONS] Scheduled: ${title}`);
  } catch (error) {
    console.error("[NOTIFICATIONS] Schedule error:", error);
  }
}

export async function scheduleAppointmentReminder(
  appointmentTime: Date,
  doctorName: string,
  patientName: string
) {
  const reminderTime = new Date(appointmentTime.getTime() - 24 * 60 * 60 * 1000);

  if (reminderTime.getTime() <= Date.now()) {
    console.log("[NOTIFICATIONS] Reminder time is in the past");
    return;
  }

  await scheduleNotification(
    "Randevu Hatırlatması",
    `Merhaba ${patientName}, yarın ${doctorName} ile randevunuz var`,
    {
      type: "date",
      timestamp: reminderTime.getTime(),
    }
  );
}

export async function removeAllNotifications() {
  try {
    await Notifications.dismissAllNotificationsAsync();
    console.log("[NOTIFICATIONS] All notifications dismissed");
  } catch (error) {
    console.error("[NOTIFICATIONS] Dismiss error:", error);
  }
}
