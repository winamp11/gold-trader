// Trading hours: single NY session window, Asia/Dubai timezone (GMT+4)
// 16:30–20:30 UAE = 08:30–12:30 UTC = NY open through mid-morning

const SESSION_START = 16 * 60 + 30; // 990 minutes since midnight
const SESSION_END   = 20 * 60 + 30; // 1230 minutes since midnight

function uaeMinutes() {
  const uaeTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  return { mins: uaeTime.getHours() * 60 + uaeTime.getMinutes(), day: uaeTime.getDay(), uaeTime };
}

export function isTradingHours() {
  const { mins, day, uaeTime } = uaeMinutes();

  if (day === 0 || day === 6) {
    console.log(`⏸️  Weekend - markets closed`);
    return false;
  }

  const inSession = mins >= SESSION_START && mins < SESSION_END;

  if (!inSession) {
    const h = uaeTime.getHours().toString().padStart(2, '0');
    const m = uaeTime.getMinutes().toString().padStart(2, '0');
    console.log(`⏸️  Outside trading hours (${h}:${m} UAE). Session: 16:30–20:30.`);
  }

  return inSession;
}

export function getNextTradingTime() {
  const { mins, day } = uaeMinutes();

  if (day === 6 || day === 0) {
    return 'Markets closed (weekend). Opens Monday 16:30 UAE';
  }

  if (mins < SESSION_START) {
    const remaining = SESSION_START - mins;
    const h = Math.floor(remaining / 60);
    const m = remaining % 60;
    return h > 0
      ? `${h}h ${m}m until session (16:30 UAE)`
      : `${m}m until session (16:30 UAE)`;
  }

  if (mins >= SESSION_END) {
    // Friday after close → next Monday; otherwise tomorrow
    const nextDay = day === 5 ? 'Monday' : 'tomorrow';
    return `Markets closed. Opens ${nextDay} 16:30 UAE`;
  }

  return 'Currently in trading hours';
}
