-- ModelMaster · 0013 sales-channel rules, second pass (replaces mm_channel from 0009).
-- Changes:
--   Xerox and Kyocera: all dealer (was: AltaLink/PrimeLink/TASKalfa dealer, the rest mostly unsure).
--   Epson: WorkForce Enterprise dealer, everything else retail (was: SureColor/ColorWorks unsure).
--   HP: PageWide P + 5 digits (P55250, P57750, P77440…) is Managed-only, so dealer like the E-series.
--       LaserJet Pro stored as "PRO-4201" and P2xxx LaserJets are retail (rule gaps in 0009).
--   (Wide format / label is now a separate field, category, from 0012.)
-- Only the function changes; model_catalog picks it up as is. Safe to re-run.

create or replace function mm_channel(p_mfr text, p_line text, p_model text)
returns text language sql immutable set search_path = public as $$
  select case
    -- Copier/MFP makers with no retail line, and makers sold through dealers.
    when p_mfr in ('Konica Minolta', 'Ricoh', 'Sharp', 'Toshiba', 'Muratec', 'Xerox', 'Kyocera') then 'dealer'

    -- HP: Managed devices are dealer: LaserJet/PageWide E + 4-5 digits, and PageWide P + 5 digits.
    -- (Managed versions of Enterprise models, like the M553xm, share the Enterprise model and are
    -- recognised per device by name in the apps that read this.) DeskJet/OfficeJet, LaserJet Pro
    -- (M1xx-M4xx, M1xxx, P/CP1xxx-2xxx, PRO-xxxx, the 3x01-4x03 Pro generation) and PageWide Pro are
    -- retail. LaserJet Enterprise, DesignJet, Latex, PageWide XL and the rest sell both ways.
    when p_mfr = 'HP' then case
      when m ~ '^E\d{4,5}(\D|$)' then 'dealer'
      when l = 'PAGEWIDE' and m ~ '^P\d{5}(\D|$)' then 'dealer'
      when l in ('DESKJET', 'OFFICEJET') then 'retail'
      when l = 'PAGEWIDE' and m ~ '^PRO' then 'retail'
      when l = 'LASERJET' and (m ~ '^PRO' or m ~ '^M[1-4]\d{2}(\D|$)' or m ~ '^M1\d{3}' or m ~ '^C?P[12]\d{3}' or m ~ '^[34]\d0[1-3](\D|$)') then 'retail'
      else 'unsure' end

    -- Canon: imageRUNNER, its successor imageFORCE, and imagePRESS are dealer. imageCLASS, PIXMA,
    -- MAXIFY are retail, as are line-less LBP/MF/TR/TS/G/GX/MB/iX/D models. imagePROGRAF and other
    -- line-less models (old NP copiers, scanners, wide format) are unsure.
    when p_mfr = 'Canon' then case
      when l in ('IR', 'IFORCE', 'IPR') then 'dealer'
      when l in ('ICLASS', 'PIXMA', 'MAXIFY') then 'retail'
      when l = '' and m ~ '^(LBP|MF|TR|TS|GX|MB|IX)\d' then 'retail'
      when l = '' and m ~ '^(G\d{3,4}|D1\d{3}|D5\d{2})(\D|$)' then 'retail'
      else 'unsure' end

    -- Lexmark: the 4-digit contract twins of the standard models (XC/XM/M/C/B/MB/MC + 4 digits, e.g.
    -- M3250 = MS621, XM3250 = MX622) are dealer, except the retail "Go Line" entry models. The standard
    -- 3-digit CS/CX/MS/MX, legacy and vertical (ST/XS/TS/ES) models sell both ways.
    when p_mfr = 'Lexmark' then case
      when m ~ '^(B2236|MB2236|C3224|C3326|C3426|MC3224|MC3326|MC3426)(\D|$)' then 'retail'
      when m ~ '^(XC|XM|MB|MC|B|C|M)\d{4}(\D|$)' then 'dealer'
      else 'unsure' end

    -- Samsung: MultiXpress A3 (K/X + 4 digits, CLX-8xxx/9xxx, M4370/M5370) is dealer; the rest retail.
    when p_mfr = 'Samsung' then case
      when m ~ '^([KX]\d{4}|CLX[89]\d{3}|SCX8\d{3}|M[45]370)(\D|$)' then 'dealer'
      else 'retail' end

    -- Epson: WorkForce Enterprise (C/M + 5 digits, e.g. WF-C21000) is dealer; everything else retail.
    when p_mfr = 'Epson' then case when m ~ '^(WF-?)?[CM]\d{5}(\D|$)' then 'dealer' else 'retail' end

    when p_mfr in ('Brother', 'Dell', 'Pantum') then 'retail'
    else null
  end
  from (select upper(coalesce(p_model, '')) as m, upper(coalesce(p_line, '')) as l) x
$$;
