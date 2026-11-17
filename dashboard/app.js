(function () {
  'use strict';

  const DATA = window.RADAR;
  const root = document.getElementById('board');
  if (!DATA || !root) return;

  const defaults = DATA.model;
  const rowsBySlug = new Map(DATA.rows.map((row) => [row.slug, row]));
  const peers = new Map(DATA.calibration.map((row) => [row.category, row]));

  // Additional board entries are strictly below the floor. Membership can
  // therefore be recovered when the above-floor count equals watchlist_size.
  const watchlist = new Set(
    DATA.rows.filter((row) => row.tvl_usd >= DATA.floor_usd)
      .map((row) => row.slug),
  );
  const watchlistRecoverable = watchlist.size === DATA.watchlist_size;

  const state = {
    q: '',
    category: '',
    chain: '',
    watchlistOnly: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
    sandbox: {
      active: false,
      growth_weight: defaults.growth_weight,
      maturity_days: defaults.maturity_days,
      breadth_per_chain: defaults.breadth_per_chain,
    },
  };

  let opener = null;
  const dialog = el('dialog', {
    class: 'detail',
    'aria-labelledby': 'detail-title',
  });
  document.body.append(dialog);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      if (key === 'class') node.className = value;
      else if (key === 'text' || key === 'html') {
        // Both keys are intentionally plain text.
        node.textContent = String(value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (
        key === 'value' ||
        key === 'checked' ||
        key === 'disabled' ||
        key === 'selected'
      ) {
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    });
    children.flat(Infinity).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function fmtUsd(value) {
    if (!Number.isFinite(value)) return 'n/a';
    const magnitude = Math.abs(value);
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [scale, suffix] of units) {
      if (magnitude >= scale) return `$${(value / scale).toFixed(2)}${suffix}`;
    }
    return `$${value.toFixed(0)}`;
  }

  function fullUsd(value) {
    return `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }

  function fmtPct(value) {
    return value === null || value === undefined || !Number.isFinite(value)
      ? 'n/a'
      : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  }

  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    return days < 365 ? `${days}d` : `${(days / 365).toFixed(1)} y`;
  }

  function fmtMult(value) {
    return `${Number(value).toFixed(4)}×`;
  }

  function compareText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function categoryOf(row) {
    return row.category === null ? 'Unknown' : row.category;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : sorted[middle - 1] / 2 + sorted[middle] / 2;
  }

  function factorsOf(row, constants) {
    const growthPct = clamp(
      row.change_7d ?? 0,
      constants.growth_floor,
      constants.growth_cap,
    );
    const growth = 1 + growthPct / 100 * constants.growth_weight;
    const age = row.age_days ?? constants.unknown_age_days;
    const maturity = constants.maturity_floor +
      constants.maturity_range *
      Math.sqrt(Math.min(age, constants.maturity_days) / constants.maturity_days);
    const breadth = 1 +
      constants.breadth_per_chain *
      Math.min(row.chains.length, constants.breadth_max_chains);
    const implied = Math.max(1, Math.round(
      row.tvl_usd *
      DATA.global_multiple *
      row.category_tilt *
      growth *
      maturity *
      breadth,
    ));
    return { implied, growthPct, growth, maturity, breadth };
  }

  function impliedOf(row, constants) {
    return factorsOf(row, constants).implied;
  }

  function sandboxConstants() {
    return {
      ...defaults,
      growth_weight: state.sandbox.growth_weight,
      maturity_days: state.sandbox.maturity_days,
      breadth_per_chain: state.sandbox.breadth_per_chain,
    };
  }

  function capitalFor(row) {
    if (row.tvl_usd >= 1e9) return 250;
    if (row.tvl_usd >= 1e8) return 150;
    if (row.tvl_usd >= 1e7) return 100;
    return 50;
  }

  function gasFor(chain) {
    switch (chain) {
      case 'Ethereum': return '$3–8';
      case 'Arbitrum':
      case 'Optimism':
      case 'Base':
      case 'Polygon':
      case 'Avalanche': return '$0.10–0.50';
      case 'Solana': return '~$0.01';
      case 'Binance': return '$0.10–0.30';
      default: return '$1–3';
    }
  }

  function actionFor(row, capital, chain) {
    const category = (row.category ?? '').toLowerCase();
    const amount = `$${capital}`;
    const matches = (...parts) => parts.some((part) => category.includes(part));

    if (matches('lend', 'cdp', 'collateral')) {
      return `Supply ${amount} of USDC to ${row.name} on ${chain} and keep the position open.`;
    }
    if (matches('dex', 'yield', 'leveraged farm')) {
      return `Provide ${amount} of liquidity to ${row.name}'s main pool on ${chain} and keep the position open.`;
    }
    if (matches('bridge')) {
      return `Bridge ${amount} of USDC to ${chain} through ${row.name} and use the bridged funds in its app.`;
    }
    if (matches('staking', 'restak')) {
      return `Stake ${amount} of the chain's staking asset through ${row.name} and keep the receipt.`;
    }
    if (matches('perpetual', 'derivative')) {
      return `Deposit ${amount} of USDC as margin on ${row.name} and open one small hedge.`;
    }
    if (matches('prediction')) {
      return `Fund ${amount} and place one market position on ${row.name}.`;
    }
    if (matches('curator', 'allocator')) {
      return `Deposit ${amount} into a ${row.name} vault on ${chain} and keep the shares.`;
    }
    if (matches('stable')) {
      return `Mint or deposit ${amount} of the stable asset through ${row.name} on ${chain}.`;
    }
    if (matches('rwa')) {
      return `Mint ${amount} of the protocol's yield asset on ${chain} and hold it.`;
    }
    if (matches('insurance')) {
      return `Buy ${amount} of cover from ${row.name} on ${chain} and keep the policy.`;
    }
    return `Deposit ${amount} of USDC into ${row.name} on ${chain} and keep the position open.`;
  }

  function stepText(step) {
    const value = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    return (value.length > 600 ? `${value.slice(0, 596)}...` : value).padEnd(20, ' ');
  }

  function farmSteps(row) {
    const capital = capitalFor(row);
    const chain = row.chains[0] ?? 'Ethereum';
    const gas = gasFor(chain);
    const age = row.age_days;
    const hold = age === null ? 45 : age < 180 ? 60 : age < 365 ? 45 : 30;

    return [
      {
        text: 'Create a fresh wallet and write down its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: `Get $${capital} of USDC onto ${chain} by bridging or withdrawing from an exchange.`,
        cost: `${gas} of gas on ${chain} plus about $1–3 in bridge fees`,
        time: '10 to 20 minutes',
      },
      {
        text: actionFor(row, capital, chain),
        cost: `$${capital} of capital and about ${gas} of gas`,
        time: '15 minutes to set up',
      },
      {
        text: 'Perform one qualifying action each week: deposit, borrow, swap or vote.',
        cost: `about ${gas} of gas a week`,
        time: '10 minutes a week',
      },
      {
        text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
        cost: `the $${capital} stays in the position`,
        time: `${hold} days`,
      },
      {
        text: "Check the protocol's own points or rewards page each week and claim only from the link it publishes; never pay to claim.",
        cost: 'no fee to check',
        time: '5 minutes a week',
      },
      {
        text: 'Keep a farm log with the wallet, dates and every transaction, plus an unwind plan: withdraw in reverse order and keep a gas reserve.',
        cost: 'nothing but the log',
        time: '5 minutes',
      },
    ].map(stepText);
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    state.q = params.get('q') || '';
    state.category = params.get('category') || '';
    state.chain = params.get('chain') || '';
    state.watchlistOnly = watchlistRecoverable && params.get('watchlist') === '1';
    state.tab = params.get('tab') === 'live' ? 'live' : 'pre-token';
    const slug = params.get('p');
    state.selected = slug && rowsBySlug.has(slug) ? slug : null;
  }

  function writeHash() {
    const params = new URLSearchParams();
    params.set('q', state.q);
    params.set('category', state.category);
    params.set('chain', state.chain);
    params.set('watchlist', state.watchlistOnly ? '1' : '0');
    params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    history.replaceState(null, '', `#${params.toString()}`);
  }

  function update(patch) {
    Object.assign(state, patch);
    writeHash();
    render();
  }

  function clearFilters() {
    update({ q: '', category: '', chain: '', watchlistOnly: false });
  }

  function filtered(source) {
    const query = state.q.trim().toLowerCase();
    return source.filter((row) => {
      if (state.category && categoryOf(row) !== state.category) return false;
      if (state.chain && !row.chains.includes(state.chain)) return false;
      if (state.watchlistOnly && !watchlist.has(row.slug)) return false;
      if (!query) return true;
      return [
        row.name, row.slug, categoryOf(row), ...row.chains,
      ].join(' ').toLowerCase().includes(query);
    });
  }

  function sortedBoard() {
    const constants = sandboxConstants();
    return filtered(DATA.rows).sort((a, b) => {
      if (state.sandbox.active) {
        return impliedOf(b, constants) - impliedOf(a, constants) ||
          compareText(a.slug, b.slug);
      }
      let result = 0;
      switch (state.sort) {
        case 'name':
          result = compareText(a.name.toLowerCase(), b.name.toLowerCase());
          break;
        case 'tvl':
          result = a.tvl_usd - b.tvl_usd;
          break;
        case 'growth':
          if (a.change_7d === null || b.change_7d === null) {
            if (a.change_7d !== b.change_7d) return a.change_7d === null ? 1 : -1;
          } else result = a.change_7d - b.change_7d;
          break;
        case 'age':
          if (a.age_days === null || b.age_days === null) {
            if (a.age_days !== b.age_days) return a.age_days === null ? 1 : -1;
          } else result = a.age_days - b.age_days;
          break;
        default:
          result = a.implied_value_usd - b.implied_value_usd;
      }
      return result * state.dir || compareText(a.slug, b.slug);
    });
  }

  function sortHeader(label, key, right) {
    const active = state.sort === key && !state.sandbox.active;
    return el('th', {
      scope: 'col',
      class: right ? 'right' : '',
      'aria-sort': active
        ? state.dir === 1 ? 'ascending' : 'descending'
        : 'none',
    }, el('button', {
      type: 'button',
      disabled: state.sandbox.active,
      onclick: () => update({
        sort: key,
        dir: state.sort === key ? -state.dir : key === 'name' ? 1 : -1,
      }),
    }, `${label}${active ? state.dir === 1 ? ' ↑' : ' ↓' : ''}`));
  }

  function growthCell(value) {
    return el('td', {
      class: `number right ${value === null ? 'muted' : value < 0 ? 'negative' : 'positive'}`,
    }, fmtPct(value));
  }

  function protocolCell(row) {
    return el('td', { class: 'protocol' },
      el('strong', {}, row.name),
      el('small', {}, `${categoryOf(row)} · ${row.chains.join(', ') || 'Chain not recorded'}`),
    );
  }

  function header() {
    return el('header', { class: 'header' },
      el('div', { class: 'brand' },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        'TOKEN RADAR',
      ),
      el('div', { class: 'meta' },
        el('span', {}, `Snapshot ${DATA.as_of}`),
        el('span', {}, 'DefiLlama protocol index'),
        el('span', {}, `${DATA.model_version} model`),
      ),
    );
  }

  function lede() {
    const highest = DATA.rows.reduce(
      (max, row) => Math.max(max, row.implied_value_usd), 0,
    );
    const middle = median(DATA.rows.map((row) => row.implied_value_usd));
    const stats = [
      ['Watchlist covered', `${watchlistRecoverable ? watchlist.size : DATA.watchlist_size}/${DATA.watchlist_size}`],
      ['Pre-token rows', DATA.board_size],
      ['Early rows below floor', DATA.early_size],
      ['Live-token set aside', DATA.live_size],
      ['Top implied value', DATA.rows.length ? fmtUsd(highest) : 'n/a'],
      ['Median implied value', middle === null ? 'n/a' : fmtUsd(middle)],
    ];
    return [
      el('section', { class: 'lede', 'aria-labelledby': 'page-title' },
        el('div', { class: 'eyebrow' }, 'Sealed snapshot / pre-token intelligence'),
        el('h1', { id: 'page-title' },
          `${DATA.watchlist_size} watchlist protocols, ranked by implied value`,
        ),
        el('p', {},
          `The ${fmtUsd(DATA.floor_usd)} TVL floor anchors the watchlist. The early radar adds every eligible protocol below that floor. Live-token protocols sit in a separate reference table. Implied value is a model, not a promise.`,
        ),
      ),
      el('section', { class: 'kpis', 'aria-label': 'Snapshot totals' },
        stats.map(([label, value]) =>
          el('div', { class: 'stat' },
            el('span', { class: 'stat-label' }, label),
            el('span', { class: 'stat-value' }, value),
          ),
        ),
      ),
    ];
  }

  function selectFilter(id, label, values, current, change) {
    const select = el('select', { id, onchange: change },
      el('option', { value: '' }, label),
      values.map((value) => el('option', { value }, value)),
    );
    select.value = current;
    return el('label', { class: 'filter', for: id },
      el('span', { class: 'sr-only' }, label),
      select,
    );
  }

  function controls(count) {
    const all = [...DATA.rows, ...DATA.live];
    const categories = [...new Set(all.map(categoryOf))].sort(compareText);
    const chains = [...new Set(all.flatMap((row) => row.chains))].sort(compareText);
    return el('section', { class: 'controls', 'aria-label': 'Radar filters' },
      el('label', { class: 'search', for: 'search' },
        el('span', { class: 'sr-only' }, 'Search protocols, categories or chains'),
        el('input', {
          id: 'search',
          type: 'search',
          value: state.q,
          placeholder: 'Search protocols, categories, chains…',
          autocomplete: 'off',
          oninput: (event) => update({ q: event.target.value }),
        }),
      ),
      selectFilter(
        'category', 'All categories', categories, state.category,
        (event) => update({ category: event.target.value }),
      ),
      selectFilter(
        'chain', 'All chains', chains, state.chain,
        (event) => update({ chain: event.target.value }),
      ),
      el('label', {
        class: 'toggle',
        title: watchlistRecoverable
          ? 'Watchlist membership recovered from the snapshot TVL floor'
          : 'Exact membership is unavailable in this dashboard dataset',
      },
        el('input', {
          id: 'watchlist',
          type: 'checkbox',
          checked: state.watchlistOnly,
          disabled: !watchlistRecoverable,
          onchange: (event) => update({ watchlistOnly: event.target.checked }),
        }),
        'Watchlist only',
      ),
      el('div', { class: 'tabs', role: 'group', 'aria-label': 'Protocol set' },
        ['pre-token', 'live'].map((tab) => el('button', {
          type: 'button',
          id: `tab-${tab}`,
          'aria-pressed': String(state.tab === tab),
          onclick: () => update({ tab }),
        }, tab === 'live' ? 'Live token' : 'Pre-token')),
      ),
      el('span', { class: 'count', role: 'status', 'aria-live': 'polite' },
        `${count} ${count === 1 ? 'row' : 'rows'} shown`,
      ),
    );
  }

  function emptyState() {
    return el('div', { class: 'empty' },
      el('h3', {}, 'No protocols match'),
      el('p', {}, 'Try a broader search or remove a filter.'),
      el('button', { class: 'primary', type: 'button', onclick: clearFilters },
        'Clear filters',
      ),
    );
  }

  function boardTable(rows) {
    const constants = sandboxConstants();
    const max = rows.reduce((value, row) => Math.max(
      value,
      state.sandbox.active ? impliedOf(row, constants) : row.implied_value_usd,
    ), 1);
    const panel = el('section', {
      class: 'panel',
      'aria-label': 'Pre-token ranked board',
    });

    if (state.sandbox.active) {
      panel.append(el('div', { class: 'banner', role: 'status' },
        'Sandbox values — not the submitted board',
      ));
    }
    if (!watchlistRecoverable) {
      panel.append(el('div', { class: 'banner' },
        'Watchlist membership cannot be recovered from this dataset; the watchlist-only filter is unavailable.',
      ));
    }
    if (!rows.length) {
      panel.append(emptyState());
      return panel;
    }

    const table = el('table', {},
      el('caption', { class: 'sr-only' },
        'Pre-token protocols. Rank is the submitted board rank; activate a row for its model and farm plan.',
      ),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Rank'),
        sortHeader('Protocol', 'name', false),
        sortHeader('TVL', 'tvl', true),
        sortHeader('7d', 'growth', true),
        sortHeader('Age', 'age', true),
        sortHeader('Implied value', 'implied', true),
        el('th', { scope: 'col' }, 'Token'),
      )),
      el('tbody', {}, rows.map((row) => {
        const displayed = state.sandbox.active
          ? impliedOf(row, constants)
          : row.implied_value_usd;
        const value = el('div', { class: 'value' },
          el('span', { class: 'number' }, fmtUsd(row.implied_value_usd)),
          state.sandbox.active
            ? el('small', { class: 'sandbox-value' }, `Sandbox ${fmtUsd(displayed)}`)
            : null,
          el('span', { class: 'bar', 'aria-hidden': 'true' },
            el('span', {
              class: 'bar-fill',
              style: `width:${clamp(displayed / max * 100, 0, 100)}%`,
            }),
          ),
        );
        return el('tr', {
          class: `interactive${state.selected === row.slug ? ' selected' : ''}`,
          tabindex: '0',
          'data-slug': row.slug,
          'aria-label': `Rank ${row.rank}, ${row.name}. Open model and farm plan.`,
          'aria-haspopup': 'dialog',
          onclick: () => openDetail(row.slug),
          onkeydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openDetail(row.slug);
            }
          },
        },
          el('td', { class: 'number muted' }, String(row.rank).padStart(2, '0')),
          protocolCell(row),
          el('td', { class: 'number right' }, fmtUsd(row.tvl_usd)),
          growthCell(row.change_7d),
          el('td', { class: 'number right muted' }, fmtAge(row.age_days)),
          el('td', { class: 'right', title: fullUsd(row.implied_value_usd) }, value),
          el('td', {}, el('span', { class: 'pill' }, 'no token')),
        );
      })),
    );
    panel.append(el('div', { class: 'table-scroll', tabindex: '0',
      'aria-label': 'Scrollable pre-token table' }, table));
    return panel;
  }

  function liveTable(rows) {
    const panel = el('section', { class: 'panel', 'aria-label': 'Live-token reference' });
    if (!rows.length) {
      panel.append(emptyState());
      return panel;
    }
    panel.append(el('div', { class: 'table-scroll', tabindex: '0',
      'aria-label': 'Scrollable live-token table' },
      el('table', {},
        el('caption', {}, 'Market cap is a fact, not a model. Snapshot values; not live quotes.'),
        el('thead', {}, el('tr', {},
          ['Status', 'Protocol', 'TVL', '7d', 'Market cap', 'Token'].map(
            (title, index) => el('th', {
              scope: 'col',
              class: index >= 2 && index <= 4 ? 'right' : '',
            }, title),
          ),
        )),
        el('tbody', {}, rows.map((row) => el('tr', {},
          el('td', {}, el('span', { class: 'pill positive' }, 'live')),
          protocolCell(row),
          el('td', { class: 'number right' }, fmtUsd(row.tvl_usd)),
          growthCell(row.change_7d),
          el('td', { class: 'number right' }, fmtUsd(row.mcap_usd)),
          el('td', {}, el('span', { class: 'pill' }, 'already trades')),
        ))),
      ),
    ));
    return panel;
  }

  function rangeControl(key, label, min, max, step, format) {
    const id = `sandbox-${key}`;
    const input = el('input', {
      id,
      type: 'range',
      min,
      max,
      step,
      value: state.sandbox[key],
      oninput: (event) => {
        state.sandbox[key] = Number(event.target.value);
        state.sandbox.active = [
          'growth_weight', 'maturity_days', 'breadth_per_chain',
        ].some((name) => Math.abs(state.sandbox[name] - defaults[name]) > 1e-9);
        render();
      },
    });
    return el('div', {},
      el('label', { class: 'range-label', for: id },
        label,
        el('output', { for: id }, format(state.sandbox[key])),
      ),
      input,
    );
  }

  function sandbox() {
    return el('section', { class: 'sandbox', 'aria-labelledby': 'sandbox-title' },
      el('div', { class: 'panel-head' },
        el('h3', { id: 'sandbox-title' }, 'Model sandbox'),
        el('button', {
          id: 'reset-sandbox',
          type: 'button',
          onclick: () => {
            Object.assign(state.sandbox, {
              active: false,
              growth_weight: defaults.growth_weight,
              maturity_days: defaults.maturity_days,
              breadth_per_chain: defaults.breadth_per_chain,
            });
            render();
          },
        }, 'Reset to radar-2 defaults'),
      ),
      state.sandbox.active
        ? el('p', { class: 'banner', role: 'status' },
            'Sandbox values — not the submitted board')
        : null,
      el('div', { class: 'ranges' },
        rangeControl('growth_weight', 'Growth weight', 0, 1, 0.05,
          (value) => value.toFixed(2)),
        rangeControl('maturity_days', 'Maturity horizon', 365, 2920, 5,
          (value) => `${value} days`),
        rangeControl('breadth_per_chain', 'Breadth per chain', 0, 0.05, 0.005,
          (value) => value.toFixed(3)),
      ),
      el('p', { class: 'note' },
        'board.json uses the defaults. Sandbox changes are local to this page; submitted ranks and values remain visible.',
      ),
    );
  }

  function modelPanel() {
    const m = defaults;
    const formula = [
      'implied = max(1, round(TVL × base × tilt × growth × maturity × breadth))',
      `base = median(live market cap / TVL) = ${fmtMult(DATA.global_multiple)}`,
      `growth = 1 + clamp(7d change or 0, ${m.growth_floor}, ${m.growth_cap}) / 100 × ${m.growth_weight}`,
      `maturity = ${m.maturity_floor} + ${m.maturity_range} × sqrt(min(age or ${m.unknown_age_days}, ${m.maturity_days}) / ${m.maturity_days})`,
      `breadth = 1 + ${m.breadth_per_chain} × min(chain count, ${m.breadth_max_chains})`,
      `tilt = clamp(category median / base, ${m.tilt_floor}, ${m.tilt_cap}); otherwise 1 with fewer than ${m.min_live_per_category} live peers`,
    ].join('\n');

    return el('section', {
      class: 'panel model-panel',
      'aria-labelledby': 'model-title',
    },
      el('div', { class: 'eyebrow' }, 'Open the equation'),
      el('h2', { id: 'model-title' }, 'How implied value is computed'),
      el('pre', { class: 'formula' }, formula),
      el('div', { class: 'factors' },
        el('p', {},
          el('strong', {}, 'Base. '),
          `TVL is multiplied by the ${fmtMult(DATA.global_multiple)} median market-cap-to-TVL ratio across all qualifying live-token protocols. The ${DATA.live_size}-row reference table is only the largest displayed subset.`,
        ),
        el('p', {},
          el('strong', {}, 'Category tilt. '),
          `With at least ${m.min_live_per_category} live peers, the raw category median divided by the global median is clamped to ${m.tilt_floor}–${m.tilt_cap}×. Smaller groups use 1×. The median column below is display-clamped to ${m.category_multiple_floor}–${m.category_multiple_cap}×; tilt uses the raw median.`,
        ),
        el('p', {},
          el('strong', {}, 'Growth. '),
          `Seven-day TVL change is clamped to ${m.growth_floor}% through ${m.growth_cap}%, then weighted by ${m.growth_weight}. Missing growth is treated as zero.`,
        ),
        el('p', {},
          el('strong', {}, 'Maturity. '),
          `A concave square-root curve starts at ${m.maturity_floor}× and reaches ${m.maturity_floor + m.maturity_range}× at ${m.maturity_days} days. Unknown age uses ${m.unknown_age_days} days. Age measures time since listing, not a verified token launch history.`,
        ),
        el('p', {},
          el('strong', {}, 'Chain breadth. '),
          `Each recorded chain adds ${m.breadth_per_chain} to the multiplier, up to ${m.breadth_max_chains} chains. This is a reach heuristic, not evidence of unique users.`,
        ),
      ),
      el('h3', {}, 'Live-peer calibration'),
      el('div', { class: 'table-scroll', tabindex: '0',
        'aria-label': 'Scrollable category calibration' },
        el('table', { class: 'compact' },
          el('caption', { class: 'sr-only' }, 'Calibration across all qualifying live protocols'),
          el('thead', {}, el('tr', {},
            ['Category', 'Live n', 'Median mcap/TVL', 'Tilt'].map(
              (label, index) => el('th', {
                scope: 'col', class: index ? 'right' : '',
              }, label),
            ),
          )),
          el('tbody', {}, DATA.calibration.map((row) => el('tr', {},
            el('td', {}, row.category),
            el('td', { class: 'number right' }, row.live_count),
            el('td', { class: 'number right' }, fmtMult(row.median_multiple)),
            el('td', { class: 'number right' }, fmtMult(row.tilt)),
          ))),
        ),
      ),
      sandbox(),
      el('p', { class: 'note' },
        '“Records no token” is not proof it has none; implied value is this entry’s own claim. It does not predict a token launch, allocation, eligibility or trading price.',
      ),
    );
  }

  function equationRow(label, value, total) {
    return el('div', { class: `equation-row${total ? ' total' : ''}` },
      el('dt', {}, label),
      el('dd', {}, value),
    );
  }

  function fillDetail(row) {
    const factors = factorsOf(row, defaults);
    const calibration = peers.get(categoryOf(row));
    const peerText = calibration
      ? calibration.live_count < DATA.model.min_live_per_category
        ? `${fmtMult(row.category_tilt)} · too few live peers (n=${calibration.live_count}) — tilt neutral`
        : `${fmtMult(row.category_tilt)} · median ${fmtMult(calibration.median_multiple)} · n=${calibration.live_count}`
      : `${fmtMult(row.category_tilt)} · no live category peers`;
    const same = factors.implied === row.implied_value_usd;
    const steps = farmSteps(row).map((text) => {
      const costAt = text.lastIndexOf(' Cost: ');
      return el('li', {},
        el('strong', {}, costAt < 0 ? text : text.slice(0, costAt)),
        costAt < 0 ? null : el('span', { class: 'chip' }, text.slice(costAt + 1)),
      );
    });

    const children = [
      el('div', { class: 'drawer-head' },
        el('span', { class: 'eyebrow' }, `Submitted rank ${row.rank}`),
        el('button', {
          type: 'button',
          'aria-label': 'Close protocol detail',
          onclick: closeDetail,
        }, 'Close ×'),
      ),
      el('h2', { id: 'detail-title' }, row.name),
      el('p', { class: 'muted' },
        `${categoryOf(row)} · ${row.chains.join(', ') || 'Chain not recorded'}`,
      ),
      el('h3', {}, 'Value equation'),
      el('dl', { class: 'equation' },
        equationRow('TVL', fullUsd(row.tvl_usd)),
        equationRow('Live-market base', fmtMult(DATA.global_multiple)),
        equationRow('7d growth', fmtPct(row.change_7d)),
        equationRow('Age with no token', fmtAge(row.age_days)),
        equationRow('Category tilt', peerText),
        equationRow('Growth multiplier', fmtMult(factors.growth)),
        equationRow('Maturity multiplier', fmtMult(factors.maturity)),
        equationRow('Breadth multiplier', fmtMult(factors.breadth)),
        equationRow('Implied value', fullUsd(row.implied_value_usd), true),
      ),
      el('p', { class: same ? 'note' : 'banner' },
        `Page recomputes this row as ${fullUsd(factors.implied)} — ${
          same ? 'the same number board.json carries.' : 'which differs from the board.'
        }`,
      ),
      calibration && calibration.live_count >= DATA.model.min_live_per_category
        ? el('p', { class: 'note' },
            'Category median shown above is display-clamped; the submitted tilt uses the raw live-peer median.',
          )
        : null,
      state.sandbox.active ? el('p', { class: 'banner' },
        `Sandbox values — not the submitted board: ${fullUsd(impliedOf(row, sandboxConstants()))}. The equation and farm plan here use submitted defaults.`,
      ) : null,
      el('h3', {}, 'Seven-step farm plan'),
      el('ol', { class: 'farm' }, steps),
      el('p', { class: 'note' },
        'An estimate, not a price. Records no token — not proof it has none.',
      ),
    ];
    dialog.replaceChildren(
      ...children.filter((child) => child !== null && child !== undefined),
    );
  }

  function openDetail(slug) {
    const row = rowsBySlug.get(slug);
    if (!row) return;
    opener = document.activeElement;
    state.selected = slug;
    writeHash();
    root.querySelectorAll('tr[data-slug]').forEach((node) => {
      node.classList.toggle('selected', node.getAttribute('data-slug') === slug);
    });
    fillDetail(row);
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else {
        dialog.setAttribute('open', '');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
      }
    }
    const button = dialog.querySelector('button');
    if (button) button.focus();
  }

  function finishClose() {
    state.selected = null;
    writeHash();
    root.querySelectorAll('tr.selected').forEach((node) => {
      node.classList.remove('selected');
    });
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }

  function closeDetail() {
    if (dialog.open && typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
      finishClose();
    }
  }

  dialog.addEventListener('close', () => {
    if (!dialog.open) finishClose();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialog.open) {
      event.preventDefault();
      closeDetail();
    }
  });

  function render() {
    const focused = document.activeElement;
    const focusId = focused && root.contains(focused) ? focused.id : '';
    let selection = null;
    if (focusId === 'search') {
      selection = [focused.selectionStart, focused.selectionEnd];
    }

    root.setAttribute('aria-busy', 'true');
    const visible = state.tab === 'live' ? filtered(DATA.live) : sortedBoard();
    root.replaceChildren(el('div', { class: 'shell' },
      header(),
      lede(),
      controls(visible.length),
      state.tab === 'live' ? liveTable(visible) : boardTable(visible),
      modelPanel(),
      el('footer', { class: 'footer' },
        el('div', {}, `Source: ${DATA.source}`),
        el('div', {},
          `Sealed as of ${DATA.as_of}. All values are USD. No network requests; no live prices.`,
        ),
      ),
    ));
    root.setAttribute('aria-busy', 'false');

    if (focusId) {
      const replacement = document.getElementById(focusId);
      if (replacement) {
        replacement.focus({ preventScroll: true });
        if (selection && typeof replacement.setSelectionRange === 'function') {
          replacement.setSelectionRange(selection[0], selection[1]);
        }
      }
    }
    if (state.selected) {
      const row = rowsBySlug.get(state.selected);
      if (row) {
        if (dialog.open) fillDetail(row);
        else openDetail(row.slug);
      }
    } else if (dialog.open) {
      closeDetail();
    }
  }

  window.addEventListener('hashchange', () => {
    readHash();
    render();
  });

  readHash();
  render();
})();
