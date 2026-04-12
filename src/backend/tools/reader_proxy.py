"""Reader-mode proxy: fetch a URL and extract clean article content.

Used when the embedded browser iframe is blocked by X-Frame-Options / CSP.
Returns structured JSON with title, content (clean HTML), author, date, etc.
"""

from __future__ import annotations

import logging
import re
import time
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup, Tag

log = logging.getLogger(__name__)

# Cache extracted articles in memory (URL → result) with TTL
_cache: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 600  # 10 minutes


def _clean_text(el: Tag) -> str:
    """Extract text from a BeautifulSoup element, collapsing whitespace."""
    return re.sub(r"\s+", " ", el.get_text(separator=" ")).strip()


def _extract_meta(soup: BeautifulSoup, *names: str) -> str | None:
    """Try multiple meta tag names/properties to find a value."""
    for name in names:
        tag = soup.find("meta", attrs={"name": name})
        if tag and tag.get("content"):
            return str(tag["content"]).strip()
        tag = soup.find("meta", attrs={"property": name})
        if tag and tag.get("content"):
            return str(tag["content"]).strip()
    return None


def _score_block(el: Tag) -> int:
    """Heuristic score for a content block — higher = more likely main content."""
    score = 0
    text = _clean_text(el)
    word_count = len(text.split())

    # Penalize very short blocks
    if word_count < 30:
        return -10

    score += min(word_count, 500)  # reward text length, cap at 500

    # Reward <p> density
    p_count = len(el.find_all("p"))
    score += p_count * 10

    # Reward common article class/id names
    cls = " ".join(el.get("class", []))
    eid = el.get("id", "")
    combined = f"{cls} {eid}".lower()

    for kw in ("article", "content", "main", "body", "post", "entry", "text",
               "abstract", "summary", "full-text", "fulltext", "paper"):
        if kw in combined:
            score += 50

    # Penalize nav, sidebar, footer, header, menu
    for kw in ("nav", "sidebar", "footer", "header", "menu", "comment",
               "advert", "banner", "cookie", "modal", "popup", "widget"):
        if kw in combined:
            score -= 100

    return score


def _is_boilerplate_class(class_list: list[str]) -> bool:
    """Check if an element's classes indicate it's boilerplate (nav, sidebar, etc.).

    We're careful NOT to match classes that merely *contain* nav/menu as a substring
    of a longer token (e.g. 'js-in-page-nav-target' is NOT a nav element).
    Only match when the keyword is the whole class or a clear compound like
    'site-nav', 'main-nav', 'nav-bar', 'sidebar-widget', etc.
    """
    BOILERPLATE_EXACT = {
        "nav", "sidebar", "footer", "header", "menu",
        "cookie", "banner", "advert", "advertisement",
        "popup", "modal", "widget", "social", "share",
        "site-nav", "main-nav", "nav-bar", "navbar",
        "cookie-banner", "cookie-consent", "ad-banner",
        "social-share", "share-buttons", "footer-nav",
        "header-nav", "site-header", "site-footer",
        "sidebar-nav", "sidebar-widget",
    }
    # Pattern: class IS one of the boilerplate keywords, or STARTS/ENDS with
    # the keyword separated by a hyphen.
    BOILERPLATE_RE = re.compile(
        r"^(?:nav(?:bar|igation)?|sidebar|footer|header|menu|cookie|banner|"
        r"advert|popup|modal|widget|social|share)$"
        r"|"
        r"^(?:site|main|page|top|bottom|global|primary)[-_]"
        r"(?:nav|header|footer|sidebar|menu)$"
        r"|"
        r"^(?:nav|header|footer|sidebar|menu)[-_]"
        r"(?:bar|container|wrapper|links|items|list|inner|outer|main|primary)$",
        re.I,
    )
    for cls in class_list:
        if cls.lower() in BOILERPLATE_EXACT:
            return True
        if BOILERPLATE_RE.match(cls):
            return True
    return False


def extract_article(html: str, url: str) -> dict:
    """Extract clean article content from raw HTML.

    Returns dict with keys:
      title, content (clean HTML string), author, date, description,
      word_count, domain, url
    """
    # Try lxml first, fall back to html.parser
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")

    # Remove unwanted elements (only actual HTML tags, not class-based)
    for tag_name in ("script", "style", "noscript", "iframe", "svg"):
        for el in soup.find_all(tag_name):
            el.decompose()

    # Remove structural nav/footer/header TAGS (not class-based)
    # Collect first, then decompose to avoid mutation during iteration
    to_remove: list[Tag] = []
    for tag_name in ("nav", "footer", "header"):
        for el in soup.find_all(tag_name):
            try:
                p_text = " ".join(p.get_text(strip=True) for p in el.find_all("p"))
                if len(p_text) > 200:
                    continue
                to_remove.append(el)
            except Exception:
                to_remove.append(el)
    for el in to_remove:
        try:
            el.decompose()
        except Exception:
            pass

    # Remove elements whose classes clearly indicate boilerplate
    to_remove = []
    for el in soup.find_all(True, class_=True):
        try:
            classes = el.get("class") or []
            if not isinstance(classes, list):
                classes = [str(classes)]
            if _is_boilerplate_class(classes):
                p_text = " ".join(p.get_text(strip=True) for p in el.find_all("p"))
                if len(p_text) > 200:
                    continue
                to_remove.append(el)
        except Exception:
            continue
    for el in to_remove:
        try:
            el.decompose()
        except Exception:
            pass

    # Extract metadata
    title = _extract_meta(soup, "og:title", "twitter:title", "citation_title")
    if not title and soup.title:
        title = soup.title.get_text(strip=True)
    title = title or "Untitled"

    author = _extract_meta(soup, "author", "og:author", "citation_author",
                           "dc.creator", "article:author")
    date = _extract_meta(soup, "article:published_time", "citation_date",
                         "date", "dc.date", "og:updated_time",
                         "citation_publication_date")
    description = _extract_meta(soup, "og:description", "description",
                                "twitter:description")
    domain = urlparse(url).hostname or ""

    # Find main content block
    # Try known article containers first
    main_el = None
    for selector in ("article", "[role='main']", "main",
                     ".article-body", ".article-content", ".content-body",
                     ".fulltext", ".full-text", "#article-body",
                     ".abstract", "#abstract"):
        candidates = soup.select(selector)
        if candidates:
            # Pick the one with most text
            main_el = max(candidates, key=lambda e: len(_clean_text(e)))
            break

    if not main_el:
        # Score all <div> and <section> blocks
        blocks = soup.find_all(["div", "section"])
        if blocks:
            scored = [(b, _score_block(b)) for b in blocks]
            scored.sort(key=lambda x: x[1], reverse=True)
            if scored[0][1] > 50:
                main_el = scored[0][0]

    if not main_el:
        # Fallback: use <body>
        main_el = soup.body or soup

    # Build clean HTML from main content
    clean_parts: list[str] = []
    for el in main_el.find_all(["h1", "h2", "h3", "h4", "h5", "h6",
                                 "p", "ul", "ol", "li", "blockquote",
                                 "table", "tr", "td", "th", "thead", "tbody",
                                 "pre", "code", "figure", "figcaption",
                                 "dl", "dt", "dd"]):
        # Skip empty elements
        text = _clean_text(el)
        if not text or len(text) < 3:
            continue

        tag = el.name
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = tag[1]
            clean_parts.append(f"<h{level}>{text}</h{level}>")
        elif tag == "p":
            clean_parts.append(f"<p>{text}</p>")
        elif tag == "blockquote":
            clean_parts.append(f"<blockquote>{text}</blockquote>")
        elif tag in ("ul", "ol"):
            items = [f"<li>{_clean_text(li)}</li>" for li in el.find_all("li")
                     if _clean_text(li)]
            if items:
                clean_parts.append(f"<{tag}>{''.join(items)}</{tag}>")
        elif tag == "table":
            clean_parts.append(str(el))
        elif tag == "pre":
            clean_parts.append(f"<pre>{text}</pre>")

    # Deduplicate consecutive identical paragraphs
    seen_paras: set[str] = set()
    deduped: list[str] = []
    for part in clean_parts:
        key = re.sub(r"<[^>]+>", "", part).strip()
        if key not in seen_paras:
            seen_paras.add(key)
            deduped.append(part)
    content_html = "\n".join(deduped)

    word_count = len(re.sub(r"<[^>]+>", " ", content_html).split())

    # If extraction is too thin, fall back to all text in main_el
    if word_count < 50:
        fallback_text = _clean_text(main_el)
        if len(fallback_text.split()) > word_count:
            # Wrap paragraphs by splitting on double-newline or sentence groups
            raw_text = main_el.get_text(separator="\n")
            paragraphs = [p.strip() for p in re.split(r"\n{2,}", raw_text) if p.strip()]
            if not paragraphs:
                paragraphs = [s.strip() for s in re.split(r"(?<=\.)\s+", fallback_text)
                              if len(s.strip()) > 20]
            fb_parts = [f"<p>{re.sub(chr(10), ' ', p).strip()}</p>"
                        for p in paragraphs if len(p.strip()) > 10]
            if fb_parts:
                content_html = "\n".join(fb_parts)
                word_count = len(re.sub(r"<[^>]+>", " ", content_html).split())

    return {
        "title": title,
        "author": author,
        "date": date,
        "description": description,
        "content": content_html,
        "word_count": word_count,
        "domain": domain,
        "url": url,
    }


async def fetch_and_extract(url: str) -> dict:
    """Fetch a URL and extract article content. Uses in-memory cache."""
    # Check cache
    if url in _cache:
        ts, data = _cache[url]
        if time.time() - ts < _CACHE_TTL:
            return data

    # Fetch with browser-like headers
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    }

    async with httpx.AsyncClient(
        follow_redirects=True, timeout=15.0, verify=False
    ) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        html = resp.text

    result = extract_article(html, url)

    # Cache result
    _cache[url] = (time.time(), result)

    # Evict old cache entries
    now = time.time()
    expired = [k for k, (ts, _) in _cache.items() if now - ts > _CACHE_TTL]
    for k in expired:
        del _cache[k]

    return result
