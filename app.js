/**
 * ============================================================================
 * SpendWise Personal Finance Tracker (app.js)
 * Connected to Central SQLite Backend Server for Multi-Device & Multi-User Sync
 * ============================================================================
 */

// --- 1. CONFIGURATION & CONSTANTS ---
const CATEGORIES = {
  expense: [
    { id: 'food', name: 'Food & Dining', icon: 'utensils', badgeColor: 'bg-amber-100 text-amber-700' },
    { id: 'housing', name: 'Housing & Rent', icon: 'home', badgeColor: 'bg-violet-100 text-violet-700' },
    { id: 'utilities', name: 'Bills & Utilities', icon: 'zap', badgeColor: 'bg-yellow-100 text-yellow-800' },
    { id: 'transportation', name: 'Transportation', icon: 'car', badgeColor: 'bg-blue-100 text-blue-700' },
    { id: 'entertainment', name: 'Entertainment', icon: 'film', badgeColor: 'bg-fuchsia-100 text-fuchsia-700' },
    { id: 'shopping', name: 'Shopping', icon: 'shopping-bag', badgeColor: 'bg-pink-100 text-pink-700' },
    { id: 'healthcare', name: 'Healthcare', icon: 'activity', badgeColor: 'bg-emerald-100 text-emerald-700' },
    { id: 'other_expense', name: 'Other Expense', icon: 'tag', badgeColor: 'bg-slate-100 text-slate-700' }
  ],
  income: [
    { id: 'salary', name: 'Salary & Wages', icon: 'briefcase', badgeColor: 'bg-emerald-100 text-emerald-700' },
    { id: 'freelance', name: 'Freelance & Consulting', icon: 'laptop', badgeColor: 'bg-teal-100 text-teal-700' },
    { id: 'investments', name: 'Investments & Dividends', icon: 'trending-up', badgeColor: 'bg-indigo-100 text-indigo-700' },
    { id: 'gift', name: 'Gifts & Awards', icon: 'gift', badgeColor: 'bg-purple-100 text-purple-700' },
    { id: 'other_income', name: 'Other Income', icon: 'plus-circle', badgeColor: 'bg-slate-100 text-slate-700' }
  ]
};

// --- 2. GLOBAL STATE ---
let currentUser = null;                 // Authenticated user: { id: number, username: string }
let authMode = 'login';                 // 'login' | 'register'
let activeFilter = 'all';               // 'all' | 'income' | 'expense'
let searchQuery = '';
let searchDebounceTimer = null;

// --- 3. DOM ELEMENTS ---
const loadingOverlay = document.getElementById('loadingOverlay');
const authSection = document.getElementById('authSection');
const dashboardSection = document.getElementById('dashboardSection');
const userProfileNav = document.getElementById('userProfileNav');
const userNameLabel = document.getElementById('userNameLabel');
const userIdBadge = document.getElementById('userIdBadge');
const welcomeUserName = document.getElementById('welcomeUserName');
const userAvatar = document.getElementById('userAvatar');
const activeUserIdTag = document.getElementById('activeUserIdTag');
const logoutBtn = document.getElementById('logoutBtn');
const exportSqliteBtn = document.getElementById('exportSqliteBtn');
const mobileExportBtn = document.getElementById('mobileExportBtn');

const authForm = document.getElementById('authForm');
const authUsernameInput = document.getElementById('authUsername');
const authPasswordInput = document.getElementById('authPassword');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authSubmitText = document.getElementById('authSubmitText');
const authHeading = document.getElementById('authHeading');
const authSubheading = document.getElementById('authSubheading');
const authErrorBox = document.getElementById('authErrorBox');
const authErrorMessage = document.getElementById('authErrorMessage');
const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const togglePasswordBtn = document.getElementById('togglePasswordBtn');
const passwordHint = document.getElementById('passwordHint');

const totalBalanceEl = document.getElementById('totalBalance');
const totalIncomeEl = document.getElementById('totalIncome');
const totalExpensesEl = document.getElementById('totalExpenses');
const incomeCountEl = document.getElementById('incomeCount');
const expenseCountEl = document.getElementById('expenseCount');
const balanceStatusBadge = document.getElementById('balanceStatusBadge');

const transactionForm = document.getElementById('transactionForm');
const descriptionInput = document.getElementById('description');
const amountInput = document.getElementById('amount');
const categorySelect = document.getElementById('category');
const dateInput = document.getElementById('date');
const descError = document.getElementById('descError');
const amountError = document.getElementById('amountError');

const transactionListContainer = document.getElementById('transactionListContainer');
const emptyState = document.getElementById('emptyState');
const historyCountText = document.getElementById('historyCountText');
const filterTypeSelect = document.getElementById('filterType');
const searchInput = document.getElementById('searchTransactions');

const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// =========================================================================
// 4. CENTRAL SERVER API CLIENT
// =========================================================================
const api = {
  token: localStorage.getItem('spendwise_token') || null,

  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem('spendwise_token', token);
    } else {
      localStorage.removeItem('spendwise_token');
    }
  },

  async request(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(endpoint, {
        ...options,
        headers
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || `Server request failed (Status: ${response.status})`);
      }

      return data;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        throw new Error('Unable to connect to SQLite server. Please ensure the server is running.');
      }
      throw err;
    }
  },

  async register(username, password) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    this.setToken(data.token);
    return data.user;
  },

  async login(username, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    this.setToken(data.token);
    return data.user;
  },

  async getMe() {
    if (!this.token) return null;
    const data = await this.request('/api/auth/me');
    return data.user;
  },

  async logout() {
    if (this.token) {
      await this.request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    this.setToken(null);
  },

  async getMetrics() {
    return await this.request('/api/metrics');
  },

  async getTransactions(filter = 'all', search = '') {
    const params = new URLSearchParams();
    if (filter && filter !== 'all') params.append('filter', filter);
    if (search && search.trim()) params.append('search', search.trim());
    const query = params.toString() ? `?${params.toString()}` : '';
    return await this.request(`/api/transactions${query}`);
  },

  async addTransaction(record) {
    const data = await this.request('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(record)
    });
    return data.transaction;
  },

  async deleteTransaction(id) {
    return await this.request(`/api/transactions/${id}`, {
      method: 'DELETE'
    });
  }
};

// =========================================================================
// 5. USER AUTHENTICATION & SESSION MANAGEMENT
// =========================================================================
tabLogin.addEventListener('click', () => setAuthMode('login'));
tabRegister.addEventListener('click', () => setAuthMode('register'));

function setAuthMode(mode) {
  authMode = mode;
  hideAuthError();

  if (mode === 'login') {
    tabLogin.className = 'py-2.5 text-xs font-bold rounded-lg transition-all duration-200 bg-white text-indigo-600 shadow-sm';
    tabRegister.className = 'py-2.5 text-xs font-bold rounded-lg transition-all duration-200 text-slate-600 hover:text-slate-900';
    authHeading.textContent = 'Welcome to SpendWise';
    authSubheading.textContent = 'Sign in to access your budget from any device';
    authSubmitText.textContent = 'Sign In';
    passwordHint.classList.add('hidden');
  } else {
    tabRegister.className = 'py-2.5 text-xs font-bold rounded-lg transition-all duration-200 bg-white text-indigo-600 shadow-sm';
    tabLogin.className = 'py-2.5 text-xs font-bold rounded-lg transition-all duration-200 text-slate-600 hover:text-slate-900';
    authHeading.textContent = 'Create New Account';
    authSubheading.textContent = 'Register an isolated profile in the central SQLite DB';
    authSubmitText.textContent = 'Create Account';
    passwordHint.classList.remove('hidden');
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();

  const username = authUsernameInput.value.trim().toLowerCase();
  const password = authPasswordInput.value;

  if (!username || !password) {
    showAuthError('Please provide both username and password.');
    return;
  }

  if (password.length < 4) {
    showAuthError('Password must be at least 4 characters.');
    return;
  }

  authSubmitBtn.disabled = true;
  authSubmitBtn.classList.add('opacity-75');

  try {
    if (authMode === 'register') {
      const newUser = await api.register(username, password);
      showToast(`Account "${newUser.username}" created successfully!`);
      loginUser(newUser, false);
    } else {
      const user = await api.login(username, password);
      loginUser(user, true);
    }
  } catch (err) {
    console.error('Authentication error:', err);
    showAuthError(err.message || 'Authentication failed. Please verify credentials.');
  } finally {
    authSubmitBtn.disabled = false;
    authSubmitBtn.classList.remove('opacity-75');
  }
});

function loginUser(user, showWelcomeToast = false) {
  currentUser = { id: user.id, username: user.username };

  userNameLabel.textContent = currentUser.username;
  welcomeUserName.textContent = currentUser.username;
  userAvatar.textContent = currentUser.username.charAt(0).toUpperCase();
  if (userIdBadge) userIdBadge.textContent = `UID: ${currentUser.id}`;
  if (activeUserIdTag) activeUserIdTag.textContent = `UID: ${currentUser.id}`;

  authSection.classList.add('hidden');
  dashboardSection.classList.remove('hidden');
  userProfileNav.classList.remove('hidden');
  mobileExportBtn.classList.remove('hidden');

  authPasswordInput.value = '';
  hideAuthError();

  refreshUserDashboard();

  if (showWelcomeToast) {
    showToast(`Welcome back, ${user.username}!`);
  }
}

/**
 * Checks server for active session token on page load/refresh.
 * If token is valid, automatically restores dashboard.
 */
async function restoreUserSession() {
  if (!api.token) return false;

  try {
    const user = await api.getMe();
    if (user) {
      loginUser(user, false);
      return true;
    }
  } catch (err) {
    console.warn('Session verification failed, logging out:', err.message);
    api.setToken(null);
  }
  return false;
}

logoutBtn.addEventListener('click', async () => {
  try {
    await api.logout();
  } catch (err) {
    console.warn('Logout request error:', err);
  }

  currentUser = null;
  dashboardSection.classList.add('hidden');
  userProfileNav.classList.add('hidden');
  mobileExportBtn.classList.add('hidden');
  authSection.classList.remove('hidden');
  authUsernameInput.value = '';
  authPasswordInput.value = '';
  hideAuthError();
  showToast('Logged out successfully');
});

// Demo credentials one-click helper
window.fillDemoCredentials = function(username, password) {
  setAuthMode('login');
  authUsernameInput.value = username;
  authPasswordInput.value = password;
  authForm.dispatchEvent(new Event('submit'));
};

function showAuthError(msg) {
  authErrorMessage.textContent = msg;
  authErrorBox.classList.remove('hidden');
}

function hideAuthError() {
  authErrorBox.classList.add('hidden');
}

togglePasswordBtn.addEventListener('click', () => {
  const type = authPasswordInput.getAttribute('type') === 'password' ? 'text' : 'password';
  authPasswordInput.setAttribute('type', type);
});

// =========================================================================
// 6. UI RENDERING FOR DASHBOARD & TRANSACTIONS
// =========================================================================
async function refreshUserDashboard() {
  if (!currentUser) return;

  try {
    // 1. Fetch Summary Metrics from Central SQLite Database
    const metrics = await api.getMetrics();

    totalIncomeEl.textContent = `+${formatCurrency(metrics.totalIncome)}`;
    totalExpensesEl.textContent = `-${formatCurrency(metrics.totalExpense)}`;
    totalBalanceEl.textContent = (metrics.netBalance < 0 ? '-' : '') + formatCurrency(Math.abs(metrics.netBalance));

    incomeCountEl.textContent = `${metrics.incomeCount} record${metrics.incomeCount === 1 ? '' : 's'}`;
    expenseCountEl.textContent = `${metrics.expenseCount} record${metrics.expenseCount === 1 ? '' : 's'}`;

    if (metrics.netBalance > 0) {
      totalBalanceEl.className = 'text-2xl sm:text-3xl font-extrabold text-emerald-600 tracking-tight';
      balanceStatusBadge.textContent = 'Profitable';
      balanceStatusBadge.className = 'inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-800 text-xs';
    } else if (metrics.netBalance < 0) {
      totalBalanceEl.className = 'text-2xl sm:text-3xl font-extrabold text-rose-600 tracking-tight';
      balanceStatusBadge.textContent = 'Deficit';
      balanceStatusBadge.className = 'inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-rose-100 text-rose-800 text-xs';
    } else {
      totalBalanceEl.className = 'text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight';
      balanceStatusBadge.textContent = 'Balanced';
      balanceStatusBadge.className = 'inline-flex items-center px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-700 text-xs';
    }

    // 2. Fetch User-Specific Transactions List
    const rows = await api.getTransactions(activeFilter, searchQuery);

    if (rows.length === 0) {
      transactionListContainer.innerHTML = '';
      emptyState.classList.remove('hidden');
      historyCountText.textContent = `0 records for user ${currentUser.username}`;
      return;
    }

    emptyState.classList.add('hidden');
    historyCountText.textContent = `Showing ${rows.length} rows for user #${currentUser.id}`;

    transactionListContainer.innerHTML = rows.map(t => {
      const isIncome = t.type === 'income';
      const cat = findCategory(t.type, t.category);
      const iconSvg = getCategoryIconSvg(cat.icon);
      const formattedAmount = `${isIncome ? '+' : '-'}${formatCurrency(t.amount)}`;
      const amountColor = isIncome ? 'text-emerald-600' : 'text-rose-600';
      const formattedDate = formatDate(t.date);

      return `
        <div class="group flex items-center justify-between p-3 sm:p-3.5 bg-white hover:bg-slate-50/80 border border-slate-200/90 hover:border-slate-300 rounded-2xl transition duration-150 shadow-xs">
          <div class="flex items-center space-x-3 min-w-0 pr-2">
            <div class="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${cat.badgeColor}">
              ${iconSvg}
            </div>
            <div class="truncate">
              <div class="flex items-center space-x-1.5">
                <p class="text-sm font-semibold text-slate-800 truncate leading-snug" title="${escapeHtml(t.description)}">
                  ${escapeHtml(t.description)}
                </p>
                <span class="text-[10px] text-slate-400 font-mono">#${t.id}</span>
              </div>
              <div class="flex items-center space-x-2 text-xs text-slate-500 mt-0.5">
                <span class="inline-block px-2 py-0.5 rounded-md font-medium text-[10px] sm:text-[11px] ${cat.badgeColor}">
                  ${escapeHtml(cat.name)}
                </span>
                <span class="text-slate-300">•</span>
                <span class="text-[11px]">${formattedDate}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center space-x-2 sm:space-x-3 shrink-0">
            <div class="text-right">
              <span class="text-sm sm:text-base font-bold ${amountColor} tabular-nums">
                ${formattedAmount}
              </span>
              <span class="block text-[9px] sm:text-[10px] uppercase font-bold tracking-wider ${isIncome ? 'text-emerald-600' : 'text-rose-500'}">
                ${t.type}
              </span>
            </div>

            <!-- Delete Button -->
            <button 
              onclick="handleDeleteTransaction(${t.id})"
              class="p-2 sm:p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 active:bg-rose-100 rounded-xl transition"
              title="Delete transaction #${t.id}"
              aria-label="Delete transaction"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('Dashboard refresh failed:', err);
    showToast(err.message || 'Failed to sync with SQLite server');
  }
}

// Global binding for inline onclick
window.handleDeleteTransaction = async function(id) {
  if (!currentUser) return;
  try {
    await api.deleteTransaction(id);
    await refreshUserDashboard();
    showToast(`Deleted transaction #${id}`);
  } catch (err) {
    console.error('Delete failed:', err);
    showToast(err.message || 'Failed to delete transaction');
  }
};

transactionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const description = descriptionInput.value.trim();
  const amount = parseFloat(amountInput.value);
  const type = getSelectedType();
  const category = categorySelect.value;
  const date = dateInput.value || new Date().toISOString().split('T')[0];

  let isValid = true;

  if (!description) {
    descError.classList.remove('hidden');
    descriptionInput.classList.add('border-rose-400');
    isValid = false;
  } else {
    descError.classList.add('hidden');
    descriptionInput.classList.remove('border-rose-400');
  }

  if (isNaN(amount) || amount <= 0) {
    amountError.classList.remove('hidden');
    amountInput.classList.add('border-rose-400');
    isValid = false;
  } else {
    amountError.classList.add('hidden');
    amountInput.classList.remove('border-rose-400');
  }

  if (!isValid) return;

  try {
    await api.addTransaction({
      type,
      description,
      amount: Math.round(amount * 100) / 100,
      category,
      date
    });

    descriptionInput.value = '';
    amountInput.value = '';
    dateInput.value = new Date().toISOString().split('T')[0];
    descriptionInput.focus();

    await refreshUserDashboard();
    showToast(`Added "${description}" (${formatCurrency(amount)})`);
  } catch (err) {
    console.error('Failed to add transaction:', err);
    showToast(err.message || 'Failed to record transaction');
  }
});

filterTypeSelect.addEventListener('change', (e) => {
  activeFilter = e.target.value;
  refreshUserDashboard();
});

searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    refreshUserDashboard();
  }, 200);
});

document.querySelectorAll('input[name="txType"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    updateCategoryDropdown(e.target.value);
  });
});

function downloadSqliteFile() {
  // Direct file stream from central SQLite backend
  window.location.href = '/api/export-db';
  showToast('Downloading central SQLite database file...');
}

exportSqliteBtn.addEventListener('click', downloadSqliteFile);
mobileExportBtn.addEventListener('click', downloadSqliteFile);

// =========================================================================
// 7. HELPER FUNCTIONS & UI UTILITIES
// =========================================================================
function formatCurrency(amount) {
  const num = Number(amount) || 0;
  const isNegative = num < 0;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(num));
  return `${isNegative ? '-' : ''}${formatted} DH`;
}

function formatDate(dateString) {
  if (!dateString) return 'No date';
  const parts = dateString.split('-');
  if (parts.length === 3) {
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }
  return dateString;
}

function updateCategoryDropdown(selectedType) {
  const type = selectedType || getSelectedType();
  const options = CATEGORIES[type] || [];

  categorySelect.innerHTML = options.map(cat => `
    <option value="${cat.id}">${cat.name}</option>
  `).join('');
}

function getSelectedType() {
  const checked = document.querySelector('input[name="txType"]:checked');
  return checked ? checked.value : 'expense';
}

function findCategory(type, categoryId) {
  const list = CATEGORIES[type] || [];
  const match = list.find(c => c.id === categoryId);
  if (match) return match;

  const altList = CATEGORIES[type === 'income' ? 'expense' : 'income'] || [];
  const altMatch = altList.find(c => c.id === categoryId);
  if (altMatch) return altMatch;

  return {
    id: categoryId,
    name: categoryId.charAt(0).toUpperCase() + categoryId.slice(1).replace('_', ' '),
    icon: 'tag',
    badgeColor: 'bg-slate-100 text-slate-700'
  };
}

function getCategoryIconSvg(iconKey) {
  switch (iconKey) {
    case 'utensils':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>`;
    case 'home':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>`;
    case 'zap':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
    case 'car':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h8m-8 4h8m-9 8h10M5 15h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v5a2 2 0 002 2z"/></svg>`;
    case 'film':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/></svg>`;
    case 'shopping-bag':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"/></svg>`;
    case 'briefcase':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;
    case 'laptop':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;
    case 'trending-up':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>`;
    case 'gift':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V4.5a2.5 2.5 0 10-5 0V8h5zm0 0V4.5a2.5 2.5 0 115 0V8h-5zM4 11h16a1 1 0 011 1v7a1 1 0 01-1 1H4a1 1 0 01-1-1v-7a1 1 0 011-1z"/></svg>`;
    case 'activity':
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
    default:
      return `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/></svg>`;
  }
}

let toastTimeout = null;
function showToast(message) {
  if (toastTimeout) clearTimeout(toastTimeout);
  toastMessage.textContent = message;
  toast.classList.remove('translate-y-20', 'opacity-0', 'pointer-events-none');
  toast.classList.add('translate-y-0', 'opacity-100');

  toastTimeout = setTimeout(() => {
    toast.classList.add('translate-y-20', 'opacity-0', 'pointer-events-none');
    toast.classList.remove('translate-y-0', 'opacity-100');
  }, 2500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// =========================================================================
// 8. BOOTSTRAP INITIALIZATION
// =========================================================================
async function initApp() {
  dateInput.value = new Date().toISOString().split('T')[0];
  updateCategoryDropdown('expense');

  try {
    const sessionRestored = await restoreUserSession();
    if (!sessionRestored) {
      authSection.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Session restoration failed:', err);
    authSection.classList.remove('hidden');
  } finally {
    if (loadingOverlay) {
      loadingOverlay.classList.add('opacity-0', 'pointer-events-none');
      setTimeout(() => loadingOverlay.remove(), 350);
    }
  }
}

// Guarantee execution when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
