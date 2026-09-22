-- Kjør først etter at administrator og arbeidssted er avklart.
-- Erstatt verdiene i hakeparenteser. Filen inneholder ingen data fra Augustum Tid.

insert into public.report_recipients(organization_id,email,recipient_type)
select id,'[ADMIN_EMAIL]','admin'
from public.organizations
where name='Apart Stavanger AS';

insert into public.worksites(organization_id,name,address,latitude,longitude,radius_meters)
select id,'[WORKSITE_NAME]','[WORKSITE_ADDRESS]',[LATITUDE],[LONGITUDE],100
from public.organizations
where name='Apart Stavanger AS';
