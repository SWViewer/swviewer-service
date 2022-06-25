sleep 2
webservice --backend=kubernetes node12 stop > log.txt
sleep 15
webservice --mem 1Gi --backend=kubernetes node12 start > log.txt
