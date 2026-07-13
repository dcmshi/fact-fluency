import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import './HowItWorksPage.css';

/**
 * Public methodology / efficacy page (COMPETITORS.md §5.6). The honest version:
 * what the app does, why it's built that way, and the learning-science
 * principles behind it — with no fabricated outcome claims. Crawlable, matches
 * the app look, localized like everything else.
 */
export function HowItWorksPage() {
  const { t } = useTranslation();

  // Give the route its own document title (SEO + tab clarity for a public page).
  useEffect(() => {
    const prev = document.title;
    document.title = t('methodology.pageTitle');
    return () => {
      document.title = prev;
    };
  }, [t]);

  const method = ['goal', 'spacing', 'gate', 'adaptive', 'throttle', 'warm'] as const;
  const research = ['r1', 'r2', 'r3', 'r4'] as const;

  return (
    <div className="screen howto">
      <header className="howto-header">
        <Link to="/" className="brand" style={{ fontSize: '1.15rem' }}>
          <span className="glyph" aria-hidden="true">
            ✦
          </span>{' '}
          Fact Fluency
        </Link>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <LanguageSwitcher />
          <Link to="/" className="btn sun">
            {t('methodology.play')}
          </Link>
        </div>
      </header>

      <article className="howto-body">
        <div className="howto-hero rise">
          <h1>{t('methodology.title')}</h1>
          <p className="howto-lede">{t('methodology.subtitle')}</p>
        </div>

        <section>
          <h2 className="howto-section-title">{t('methodology.methodHeading')}</h2>
          <div className="howto-steps">
            {method.map((k) => (
              <div className="howto-step" key={k}>
                <h3>{t(`methodology.${k}Title`)}</h3>
                <p>{t(`methodology.${k}Body`)}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="howto-section-title">{t('methodology.researchHeading')}</h2>
          <p className="howto-lede sm">{t('methodology.researchIntro')}</p>
          <div className="howto-research">
            {research.map((k) => (
              <div className="howto-research-card" key={k}>
                <strong>{t(`methodology.${k}Term`)}</strong>
                <span>{t(`methodology.${k}Body`)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* The signature moment: the honest "what we don't claim" callout. */}
        <section className="howto-callout">
          <h2>{t('methodology.honestTitle')}</h2>
          <p>{t('methodology.honestBody')}</p>
          <h2 style={{ marginTop: '1.2rem' }}>{t('methodology.privacyTitle')}</h2>
          <p>{t('methodology.privacyBody')}</p>
        </section>

        <div className="howto-cta">
          <Link to="/" className="btn sun full">
            {t('methodology.ctaPlay')}
          </Link>
          <Link to="/" className="btn ghost">
            {t('methodology.ctaBack')}
          </Link>
        </div>
      </article>
    </div>
  );
}
