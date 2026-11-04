import { projectNameFrom, titleFrom } from '../chats.js';

describe('chat titles', () => {
  it('uses the first words of the first message', () => {
    expect(titleFrom('blink the onboard LED')).toBe('Blink the onboard LED');
    expect(titleFrom('  show   temperature\non an LCD ')).toBe('Show temperature on an LCD');
  });

  it('never ends a cut title on a conjunction or article', () => {
    expect(titleFrom('Blink the onboard LED every 500 ms and print each toggle to Serial')).toBe('Blink the onboard LED every 500 ms');
    expect(titleFrom('Read a DHT22 and show the temperature on the LCD with a backlight')).toBe('Read a DHT22 and show the temperature');
  });

  it('keeps a short message whole, even when it ends on such a word', () => {
    expect(titleFrom('what is this for')).toBe('What is this for');
  });

  it('cuts very long words at 56 characters with an ellipsis', () => {
    const title = titleFrom('Supercalifragilisticexpialidocious configuration parameters for the ultrasonic distance sensor module');
    expect(title.length).toBeLessThanOrEqual(56);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to "New chat" for an empty message', () => {
    expect(titleFrom('')).toBe('New chat');
    expect(titleFrom('   ')).toBe('New chat');
  });
});

describe('project folder names', () => {
  it('keeps the words that matter, as a sketch folder name', () => {
    expect(projectNameFrom('Blink the onboard LED every 500 ms and print each toggle to Serial')).toBe('blink_onboard_led_500');
    expect(projectNameFrom('Fade an LED on pin 9 with a potentiometer on A0')).toBe('fade_led_pin_9');
  });

  it('never produces a name a sketch folder cannot have', () => {
    expect(projectNameFrom('¡¡¡ ???')).toMatch(/^project_\d{8}$/);
    expect(projectNameFrom('the a an')).toMatch(/^project_\d{8}$/);
    expect(projectNameFrom('_leading underscore')).toBe('leading_underscore');
  });
});
