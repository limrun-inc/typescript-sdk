export const isMicrophoneCaptureWanted = (manual: boolean, guestDemand: boolean): boolean =>
  manual || guestDemand;
