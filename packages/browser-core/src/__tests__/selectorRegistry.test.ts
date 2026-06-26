import { SelectorRegistry } from '../selectorRegistry';
import type { SelectorReader } from '../selectorConfig';

function mockReader(getSelectorImpl: any): SelectorReader {
  return { getSelector: getSelectorImpl, getSelectorList: () => [] } as any;
}

describe('SelectorRegistry', () => {
  it('resolves douyin.monitor.menu_home via flow→category mapping', () => {
    const reader = mockReader((_p: string, cat: string, name: string) =>
      cat === 'menus' && name === 'menu_home'
        ? { primary: '#home', fallbacks: ['.home'], selectorType: 'css', purposes: ['monitor'] }
        : null,
    );
    SelectorRegistry.setReader(reader);
    const r = SelectorRegistry.get('douyin.monitor.menu_home');
    expect(r).not.toBeNull();
    expect(r!.primary).toBe('#home');
    expect(r!.fallbacks).toEqual(['.home']);
    expect(r!.selectorKey).toBe('douyin.monitor.menu_home');
  });

  it('returns null for unknown key', () => {
    SelectorRegistry.setReader(mockReader(() => null));
    expect(SelectorRegistry.get('douyin.monitor.no_such')).toBeNull();
  });

  it('maps key prefixes: btn_→buttons, region_→regions, input_→textboxes', () => {
    const reader = mockReader((_p: string, cat: string, name: string) =>
      ({ primary: `#${cat}-${name}`, fallbacks: [], selectorType: 'css', purposes: [] }));
    SelectorRegistry.setReader(reader);
    expect(SelectorRegistry.get('douyin.publish.btn_submit')!.primary).toBe('#buttons-btn_submit');
    expect(SelectorRegistry.get('douyin.monitor.region_work_list')!.primary).toBe('#regions-region_work_list');
    expect(SelectorRegistry.get('douyin.publish.input_caption')!.primary).toBe('#textboxes-input_caption');
  });

  it('falls back to scanning all categories when prefix is ambiguous', () => {
    const reader = mockReader((_p: string, cat: string, name: string) =>
      cat === 'regions' && name === 'work_list'
        ? { primary: '#rl', fallbacks: [], selectorType: 'css', purposes: [] }
        : null);
    SelectorRegistry.setReader(reader);
    expect(SelectorRegistry.get('douyin.monitor.work_list')!.primary).toBe('#rl');
  });
});
