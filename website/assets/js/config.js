// Addresses the site talks to. The price is written in the pages themselves: search for $19.99 to change it,
// and change PRICE_CENTS in supabase/functions/license/core.ts to match.
window.DOGFILE = {
  // the license server: thanks.html asks it for the serial number (the Buy links point at its /buy)
  licenseApi: 'https://armnbgeluofwseufpqge.supabase.co/functions/v1/license',
};
