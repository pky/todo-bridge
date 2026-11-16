import { expect } from 'e2e'
import { test, dismissTitle, readLaterTitle } from './ai-news.fixture'

for (const viewport of [
  { width: 1100, height: 800 },
  { width: 1440, height: 900 },
  { width: 1023, height: 800 },
]) {
  const multiColumn = viewport.width >= 1024

  test(`${viewport.width}px幅でAIニュースが${multiColumn ? '多列' : '1列'}配置になる`, async ({ app, screen, browser, aiDemo }) => {
    await browser.setViewport(viewport)
    await app.open('/news/ai')
    await expect(screen.getByRole('heading', 'AIニュース')).toBeVisible()
    await expect(screen.getByText(dismissTitle, { visible: true })).toBeVisible()
    await expect(screen.getByText(readLaterTitle, { visible: true })).toBeVisible()

    const layout = await browser.evaluate(({ heroTitle, featuredTitle }) => {
      function measureCard(title: string) {
        const heading = Array.from(document.querySelectorAll('p')).find(element =>
          element.textContent?.trim() === title)
        const card = heading?.closest('div.cursor-pointer')
        if (!card) throw new Error(`記事タイトルに対応するカードがありません: ${title}`)
        const rect = card.getBoundingClientRect()
        return { left: rect.left, width: rect.width, minHeight: getComputedStyle(card).minHeight }
      }

      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hero: measureCard(heroTitle),
        featured: measureCard(featuredTitle),
      }
    }, { heroTitle: dismissTitle, featuredTitle: readLaterTitle })

    expect(layout.viewportWidth).toBe(viewport.width)
    expect(layout.viewportHeight).toBe(viewport.height)
    expect(layout.hero.width).toBeGreaterThan(0)
    expect(layout.featured.width).toBeGreaterThan(0)
    // 未対応の幅でも全条件を照合し、画面の証跡を残す。
    if (multiColumn) {
      expect.soft(layout.hero.width).toBeLessThan(layout.viewportWidth * 0.6)
      expect.soft(layout.featured.width).toBeLessThan(layout.hero.width)
      expect.soft(layout.hero.minHeight).toBe('360px')
    } else {
      expect.soft(Math.abs(layout.hero.left - layout.featured.left)).toBeLessThanOrEqual(2)
      expect.soft(layout.hero.width).toBeGreaterThanOrEqual(layout.viewportWidth * 0.8)
      expect.soft(layout.featured.width).toBeGreaterThanOrEqual(layout.viewportWidth * 0.8)
      expect.soft(layout.hero.minHeight).not.toBe('360px')
    }
    expect(aiDemo.actions).toEqual([])
    await app.screenshot(`ai-news-layout-${viewport.width}`)
  })
}
